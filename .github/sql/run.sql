begin;
set local request.headers = '{"x-session": "e2e-mute-probe2"}';
insert into sessions (token_hash, user_id, expires_at, gate_ok)
select encode(digest('e2e-mute-probe2','sha256'),'hex'), u.id, now() + interval '1 hour', true
from users u where u.status='active' limit 1;
do $$
declare d jsonb; rid text; uid uuid; n int;
begin
  select id into rid from rooms limit 1;
  select id into uid from users where status='active' limit 1;
  raise notice '  rid=% uid=%', rid, uid;
  -- ⚠ room_members 线上是空的（还没人真正加过群），
  --   事务内补一条再测，rollback 后不留痕。
  insert into room_members (room_id, user_id) values (rid, uid) on conflict do nothing;

  perform room_mute(rid, uid, 10);
  d := state_delta(0)::jsonb;
  raise notice '① 禁言后 roomMuted = %', (d->'rooms'->0)->'roomMuted';
  raise notice '② room.mute 权限点已注册 = %',
    exists(select 1 from acl_perm_label where key='room.mute');
  raise notice '③ ROOM_INHERENT 含 room.mute = %',
    ('room.mute' = any(acl_room_inherent()));

  perform room_mute(rid, uid, 0);
  d := state_delta(0)::jsonb;
  raise notice '④ 解禁后 roomMuted = %', (d->'rooms'->0)->'roomMuted';
  raise notice '⑤ room_mute 重载数 = %',
    (select count(*) from pg_proc where proname='room_mute');
end $$;
rollback;
