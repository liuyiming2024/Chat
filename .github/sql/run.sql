create or replace function state_get()
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare me uuid;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
  me := cur_user();
  return json_build_object(
    'me', me,
    'site', (select row_to_json(s) from (
      select site_name, allow_register, (gate_hash is not null) as has_gate from site where id = true) s),
    'users', coalesce((select json_agg(json_build_object(
        'id', u.id, 'nick', u.nick, 'realName', u.real_name, 'role', u.role,
        'status', u.status, 'perms', u.perms, 'bio', u.bio,
        'mutedUntil', (extract(epoch from u.muted_until) * 1000)::bigint,
        'createdAt', (extract(epoch from u.created_at) * 1000)::bigint,
        'lastSeen', (extract(epoch from u.last_seen) * 1000)::bigint
      )) from users u), '[]'::json),
    'rooms', coalesce((select json_agg(r) from (
      select json_build_object(
        'id', rm.id, 'name', rm.name, 'type', rm.type, 'owner', rm.owner_id,
        'desc', rm.description, 'notice', rm.notice,
        'hasPwd', (rm.pwd_hash is not null),
        'createdAt', (extract(epoch from rm.created_at) * 1000)::bigint,
        'members', coalesce((select json_agg(mm.user_id) from room_members mm where mm.room_id = rm.id), '[]'::json),
        'admins', coalesce((select json_agg(aa.user_id) from room_admins aa where aa.room_id = rm.id), '[]'::json),
        /* 被单独关掉邀请权的成员。
           不回传的话前端刷新一次开关就"自己弹回来"——
           而服务端其实已经禁掉了，界面与事实不符。 */
        'noInvite', coalesce((select json_agg(ni.user_id) from room_members ni
                              where ni.room_id = rm.id and ni.can_invite = false), '[]'::json)
      ) as r from rooms rm) x), '[]'::json),
    /* order by 必须写在 json_agg(...) 内部。
       写成 json_agg(x) ... order by m.created_at 会让整句变成聚合查询，
       报 "column must appear in the GROUP BY clause" —— 本地测试没跑到
       state_get 所以没暴露，真连上才炸。 */
    'messages', coalesce((select json_agg(json_build_object(
        'id', m.id, 'room', m.room_id, 'from', m.from_id, 'type', m.type,
        'text', m.body, 'mediaId', m.media_path, 'name', m.media_name,
        'size', m.media_size, 'replyTo', m.reply_to,
        'deleted', m.deleted,
   'edited',  m.edited_at,
        'ts', (extract(epoch from m.created_at) * 1000)::bigint
      ) order by m.created_at) from messages m
      where m.created_at > now() - interval '30 days'
        -- 只能看到自己所在房间的消息。
        -- 原来不加这层：私聊和别人的群聊会一视同仁全量返回。
        and (
          exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
          or exists (select 1 from room_members mm
                     where mm.room_id = m.room_id and mm.user_id = me)
        )
      ), '[]'::json),
    'logs', coalesce((select json_agg(json_build_object(
        'id', l.id, 'who', l.who_id, 'act', l.act, 'detail', l.detail,
        'target', l.target, 'ts', (extract(epoch from l.created_at) * 1000)::bigint
      )) from (select * from logs order by created_at desc limit 200) l), '[]'::json)
  );
end;
$$;


create or replace function state_delta(p_since bigint default 0)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare me uuid; v_from timestamptz; v_rev bigint;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
  me := cur_user();
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
      select site_name, allow_register, (gate_hash is not null) as has_gate from site where id = true) s),
    /* 用户与房间量小且变动会牵动权限，每次都带上，不做增量 */
    'users', coalesce((select json_agg(json_build_object(
        'id', u.id, 'nick', u.nick, 'realName', u.real_name, 'role', u.role,
        'status', u.status, 'perms', u.perms, 'bio', u.bio,
        'mutedUntil', (extract(epoch from u.muted_until) * 1000)::bigint,
        'createdAt', (extract(epoch from u.created_at) * 1000)::bigint,
        'lastSeen', (extract(epoch from u.last_seen) * 1000)::bigint
      )) from users u), '[]'::json),
    'rooms', coalesce((select json_agg(r) from (
      select json_build_object(
        'id', rm.id, 'name', rm.name, 'type', rm.type, 'owner', rm.owner_id,
        'desc', rm.description, 'notice', rm.notice,
        'hasPwd', (rm.pwd_hash is not null),
        'createdAt', (extract(epoch from rm.created_at) * 1000)::bigint,
        'members', coalesce((select json_agg(mm.user_id) from room_members mm where mm.room_id = rm.id), '[]'::json),
        'admins', coalesce((select json_agg(aa.user_id) from room_admins aa where aa.room_id = rm.id), '[]'::json),
        /* 被单独关掉邀请权的成员。
           不回传的话前端刷新一次开关就"自己弹回来"——
           而服务端其实已经禁掉了，界面与事实不符。 */
        'noInvite', coalesce((select json_agg(ni.user_id) from room_members ni
                              where ni.room_id = rm.id and ni.can_invite = false), '[]'::json)
      ) as r from rooms rm) x), '[]'::json),
    'messages', coalesce((select json_agg(json_build_object(
        'id', m.id, 'room', m.room_id, 'from', m.from_id, 'type', m.type,
        'text', m.body, 'mediaId', m.media_path, 'name', m.media_name,
        'size', m.media_size, 'replyTo', m.reply_to,
        'deleted', m.deleted,
   'edited',  m.edited_at,
        'ts', (extract(epoch from m.created_at) * 1000)::bigint
      ) order by m.rev) from messages m
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
      ), '[]'::json),
    'logs', coalesce((select json_agg(json_build_object(
        'id', l.id, 'who', l.who_id, 'act', l.act, 'detail', l.detail,
        'target', l.target, 'ts', (extract(epoch from l.created_at) * 1000)::bigint
      ) order by l.created_at desc) from (
        select * from logs where created_at > v_from order by created_at desc limit 200
      ) l), '[]'::json)
  );
end;
$$;


-- ---------- 验证 ----------
\echo '=== state_get 是否回传 noInvite ==='
select case when prosrc like '%noInvite%' then 'OK 有 noInvite'
       else '缺 noInvite' end from pg_proc where proname='state_get';
select case when prosrc like '%noInvite%' then 'OK 有 noInvite'
       else '缺 noInvite' end from pg_proc where proname='state_delta';
