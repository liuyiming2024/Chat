create or replace function state_delta(p_since bigint default 0)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare me uuid; v_from timestamptz; v_rev bigint;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
  me := cur_user();
  /* ★ 同 state_get（Q-Chat-S-130 / 外部报告 C-3）：增量接口同样要限制未登录。
     ⚠ 只堵 state_get 等于没堵 —— 绕过它直接调 state_delta
     能拿到完全一样的东西。两个口子必须一起堵。

     ⚠⚠ 但同样**不能抛异常**（S-137，与 state_get 同理）：
        抛异常会打断前端启动，表现为"站点未初始化、要重新建站"。
        这里返回空增量，安全性一样（未登录拿不到任何内容）。 */
  if me is null then
    return json_build_object(
      'serverNow', (extract(epoch from now()) * 1000)::bigint,
      'rev', (select last_value from state_rev),
      'needLogin', true,
      'users', '[]'::json, 'rooms', '[]'::json,
      'messages', '{}'::json, 'members', '[]'::json
    );
  end if;
  v_rev := (select last_value from state_rev);

  /* 时间窗只给 logs 用（它没 rev 列）。
     ⚠ messages 曾经也用这个窗拉增量，那是错的：
       rev 差 × 2 秒只是估算，站点冷清时 rev 差小、窗窄，
       离线期间的消息会落在窗外 —— 前端按 id merge，缺了就永远缺了。
     messages 现在直接比 rev（见下方 where m.rev > p_since），精确且可索引。 */
  if coalesce(p_since, 0) <= 0 then
    v_from := now() - interval '30 days';
  else
    v_from := now() - make_interval(secs => greatest(0, v_rev - p_since) * 2 + 30);
  end if;

  return json_build_object(
    'rev', v_rev,
    'me', me,
    'site', (select row_to_json(s) from (
      select site_name, allow_register, (gate_hash is not null) as has_gate,
             -- Q-Chat-S-120：无门模式。前端据此跳过密码框。
             coalesce(gate_disabled, false) as gate_off from site where id = true) s),
    /* 用户与房间量小且变动会牵动权限，每次都带上，不做增量 */
    'users', coalesce((select json_agg(json_build_object(
        'id', u.id, 'nick', u.nick, 'realName', u.real_name, 'role', u.role,
        'status', u.status, 'perms', u.perms, 'bio', u.bio,
        'mutedUntil', (extract(epoch from u.muted_until) * 1000)::bigint,
        'createdAt', (extract(epoch from u.created_at) * 1000)::bigint,
        'lastSeen', (extract(epoch from u.last_seen) * 1000)::bigint,
        /* ⚠ rev 必须回传（S-085）。
           不回传的话前端只能拿 lastSeen 顶替"资料版本"，
           于是**每次上线都算一次"资料变更"**，合并判据彻底失真。 */
        'rev', u.rev,
        'avatar', u.avatar
      )) from users u), '[]'::json),
    'rooms', coalesce((select json_agg(r) from (
      select json_build_object(
        'id', rm.id, 'name', rm.name, 'type', rm.type, 'owner', rm.owner_id,
        'desc', rm.description, 'notice', rm.notice,
        'hasPwd', (rm.pwd_hash is not null),
        'createdAt', (extract(epoch from rm.created_at) * 1000)::bigint,
        /* ⚠ rev 必须回传（S-085，这条最要紧）。
           rooms 表**根本没有 updated_at 列**，前端 tRoom 只能拿
           created_at 顶替 —— 而 created_at 永远不变。
           于是 mergeArr 的 `x.updatedAt > o.updatedAt` 恒为 false，
           **房间资料的合并分支永远不执行**：
           服务端改了房间名/公告，前端同步回来时被整个丢弃。
           这正是"公告改了不同步""置顶只改本地"那一族问题的共同根因。 */
        'rev', rm.rev,
        'members', coalesce((select json_agg(mm.user_id) from room_members mm where mm.room_id = rm.id), '[]'::json),
        'admins', coalesce((select json_agg(aa.user_id) from room_admins aa where aa.room_id = rm.id), '[]'::json),
        /* 被单独关掉邀请权的成员。
           不回传的话前端刷新一次开关就"自己弹回来"——
           而服务端其实已经禁掉了，界面与事实不符。 */
        'noInvite', coalesce((select json_agg(ni.user_id) from room_members ni
                              where ni.room_id = rm.id and ni.can_invite = false), '[]'::json),
        /* ⚠ 群内禁言必须回传（S-113）。
           不回传的话前端只能继续用本地 room.muted 数组 ——
           而数组改的是本地、换设备就没、被禁者自己改一下就解了，
           **服务端根本不知道有过这次禁言**。
           这里回传"仍在生效"的禁言：user_id → 到期时间戳（毫秒）。
           已过期的不再回传（前端据此自动解禁，不用等定时器）。 */
        'roomMuted', coalesce((select json_object_agg(
            mu.user_id,
            (extract(epoch from mu.muted_until) * 1000)::bigint)
          from room_members mu
          where mu.room_id = rm.id
            and mu.muted_until is not null
            and mu.muted_until > now()), '{}'::json)
      ) as r from rooms rm) x), '[]'::json),
    /* ⚠ 消息增量必须分页，不能一次拉全表（S-095）。
       原来这里**没有任何 limit**：离线三天回来，一次拉回期间的全部消息。
       消息多到一定程度，这个请求会：
         - 超出网关响应体上限 → 直接失败
         - 或慢到超时，前端重试，于是**永远拉不下来**
       而失败的表现只是"消息一直是旧的"，用户看不出是拉取卡住了。

       ⚠ 但**不能简单加 limit 就完事** —— 那是最危险的做法：
         截断后前端拿到的是"一部分消息"，而 p_since 会推进到最新 rev，
         中间没拉到的那些**永远拉不到了**（下一次从新 rev 开始）。
         这就成了静默丢失：少了消息，且没有任何提示。

       所以必须同时返回游标：
         msgCursor = 本次这批消息的最大 rev
         msgMore   = 后面还有没有
       前端拿到 msgMore=true 时，用 msgCursor 继续拉，直到 false。
       ⚠ 消息游标必须**独立于全局 rev 保存** ——
         用全局 rev 覆盖它，就等于把没拉到的那批标成"已拉过"。 */
    'messages', coalesce((select json_agg(json_build_object(
        'id', t.id, 'room', t.room_id, 'from', t.from_id, 'type', t.type,
        'text', t.body, 'mediaId', t.media_path, 'name', t.media_name,
        'size', t.media_size, 'replyTo', t.reply_to,
        'deleted', t.deleted,
        'edited', t.edited_at,
        'ts', (extract(epoch from t.created_at) * 1000)::bigint
      ) order by t.rev) from (
        select m.id, m.room_id, m.from_id, m.type, m.body, m.media_path,
               m.media_name, m.media_size, m.reply_to, m.deleted,
               m.edited_at, m.created_at, m.rev
          from messages m
         /* ⚠ 是 >= 不是 >。
            客户端拿到的 p_since 来自 state_peek()，那是"最后分配出去的号"，
            而最后分配的号往往正是刚发的那条消息的 rev。
            用 > 会把这条漏掉 —— 用户自己发的消息，自己这边看不到。
            用 >= 最多重复送最后一条，前端按 id merge 会去重，无害。 */
         where coalesce(m.rev, 0) >= coalesce(p_since, 0)
           and (
             exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
             or exists (select 1 from room_members mm
                        where mm.room_id = m.room_id and mm.user_id = me)
           )
         order by m.rev
         limit 500
      ) t), '[]'::json),
    'msgCursor', coalesce((select max(t.rev) from (
        select m.rev from messages m
         where coalesce(m.rev, 0) >= coalesce(p_since, 0)
           and (
             exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
             or exists (select 1 from room_members mm
                        where mm.room_id = m.room_id and mm.user_id = me)
           )
         order by m.rev limit 500) t), coalesce(p_since, 0)),
    'msgMore', (select count(*) > 500 from (
        select 1 from messages m
         where coalesce(m.rev, 0) >= coalesce(p_since, 0)
           and (
             exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
             or exists (select 1 from room_members mm
                        where mm.room_id = m.room_id and mm.user_id = me)
           )
         order by m.rev limit 501) t),
    'logs', coalesce((select json_agg(json_build_object(
        'id', l.id, 'who', l.who_id, 'act', l.act, 'detail', l.detail,
        'target', l.target, 'ts', (extract(epoch from l.created_at) * 1000)::bigint
      ) order by l.created_at desc) from (
        select * from logs where rev > p_since order by rev desc limit 200
      ) l), '[]'::json)
  );
end;
$$;

/* 新 RPC 一律先写鉴权：序号本身不敏感，但它暴露"站点是否在活跃变化"，
   且轮询接口不该对未过门禁的人开放。 */
