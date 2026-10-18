create or replace function state_get()
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare me uuid;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
  me := cur_user();

  /* ★★ Q-Chat-S-137：未登录时**不能抛异常**，要返回最小载荷。

     上一版（S-131 / 外部报告 C-3）在这里写了
       `if me is null then raise exception '请先登录'; end if;`
     安全意图是对的（不能把全站用户资料与聊天记录发给未登录者），
     但**它把启动流程整个打断了**：

       前端 boot → pull() → state_get() → 抛异常 → catch → 判定"连不上/未初始化"
       → 退回本地模式 → 弹出"首次进入：请设置保护密码并创建站长账号"

     于是用户打开聊天室，看到的既是要设保护密码（门禁）、
     又是要创建站长账号（初始化）—— 而站点明明早就建好了、门禁也早关了。
     这个故障从 S-131 起一直存在，我一次都没真机打开验证过。

     ★ 正确做法：未登录就返回**最小载荷**（只有服务端时间 + 站点公开信息），
       用户/房间/消息一律为空。这样：
         · 安全目标达成 —— 未登录拿不到任何用户资料与聊天记录
         · 启动流程不断 —— 前端能继续走到 loginView()
       抛异常是把"没有数据"和"出错了"混为一谈，而这两件事该分开。 */
  if me is null then
    return json_build_object(
      'serverNow', (extract(epoch from now()) * 1000)::bigint,
      'me', null,
      'needLogin', true,
      'site', (select row_to_json(s) from (
        select site_name, allow_register, (gate_hash is not null) as has_gate,
               coalesce(gate_disabled, false) as gate_off from site where id = true) s),
      'users', '[]'::json, 'rooms', '[]'::json, 'messages', '{}'::json
    );
  end if;

  return json_build_object(
    /* ⚠ 服务端时间必须下发（E-049 / S-065）。
       前端的"在线判定"和"撤回时限"都拿本机 Date.now()
       去比服务端的 last_seen / created_at ——
       本机钟快 5 分钟 → 所有人永远显示离线；
       本机钟慢 → 所有人永远在线，且能撤回任意旧消息。
       这种偏差用户看不出原因，只会觉得软件不准。
       所以下发服务端时间，客户端据此算出偏移量。 */
    'serverNow', (extract(epoch from now()) * 1000)::bigint,
    'me', me,
    'site', (select row_to_json(s) from (
      select site_name, allow_register, (gate_hash is not null) as has_gate,
             -- Q-Chat-S-120：无门模式。前端据此跳过密码框。
             coalesce(gate_disabled, false) as gate_off from site where id = true) s),
    'users', coalesce((select json_agg(json_build_object(
        'id', u.id, 'nick', u.nick, 'realName', u.real_name, 'role', u.role,
        'status', u.status, 'perms', u.perms, 'bio', u.bio,
        'mutedUntil', (extract(epoch from u.muted_until) * 1000)::bigint,
        'createdAt', (extract(epoch from u.created_at) * 1000)::bigint,
        'lastSeen', (extract(epoch from u.last_seen) * 1000)::bigint,
        /* ⚠ rev 必须回传（S-085）。
           不回传的话前端只能拿 lastSeen 顶替"资料版本"，
           于是**每次上线都算一次"资料变更"**，合并判据彻底失真。 */
        'rev', u.rev
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
    /* order by 必须写在 json_agg(...) 内部。
       写成 json_agg(x) ... order by m.created_at 会让整句变成聚合查询，
       报 "column must appear in the GROUP BY clause" —— 本地测试没跑到
       state_get 所以没暴露，真连上才炸。 */
    /* 同 state_delta：全量首次拉取也要分页（S-095）。
       这里只取最近 30 天内、**最新的 500 条**（按 rev 倒序再正序还原）。
       注意是"最新的"而不是"最旧的" ——
       首次打开时用户要看的是最近的消息，不是一个月前的。
       剩下更旧的由前端拿 msgCursor 继续往前补（见 msgMore）。 */
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
         where m.created_at > now() - interval '30 days'
           -- 只能看到自己所在房间的消息。
           -- 原来不加这层：私聊和别人的群聊会一视同仁全量返回。
           and (
             exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
             or exists (select 1 from room_members mm
                        where mm.room_id = m.room_id and mm.user_id = me)
           )
         order by m.rev desc limit 500
      ) t), '[]'::json),
    'msgCursor', coalesce((select min(t.rev) from (
        select m.rev from messages m
         where m.created_at > now() - interval '30 days'
           and (
             exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
             or exists (select 1 from room_members mm
                        where mm.room_id = m.room_id and mm.user_id = me)
           )
         order by m.rev desc limit 500) t), 0),
    'msgMore', (select count(*) > 500 from (
        select 1 from messages m
         where m.created_at > now() - interval '30 days'
           and (
             exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
             or exists (select 1 from room_members mm
                        where mm.room_id = m.room_id and mm.user_id = me)
           )
         limit 501) t),
    'logs', coalesce((select json_agg(json_build_object(
        'id', l.id, 'who', l.who_id, 'act', l.act, 'detail', l.detail,
        'target', l.target, 'ts', (extract(epoch from l.created_at) * 1000)::bigint
      )) from (select * from logs order by created_at desc limit 200) l), '[]'::json)
  );
end;
$$;
