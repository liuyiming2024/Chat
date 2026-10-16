begin;
set local request.headers = '{"x-session": "e2e-mute-probe"}';
insert into sessions (token_hash, user_id, expires_at, gate_ok)
select encode(digest('e2e-mute-probe','sha256'),'hex'), u.id, now() + interval '1 hour', true
from users u where u.status='active' limit 1;
do $$
declare d jsonb; rid text; uid uuid;
begin
  select id into rid from rooms limit 1;
  select user_id into uid from room_members where room_id=rid limit 1;
  if rid is null or uid is null then raise notice '无房间或无成员，跳过'; return; end if;
  -- 禁言 10 分钟
  perform room_mute(rid, uid, 10);
  d := state_delta(0)::jsonb;
  raise notice '① 禁言后 roomMuted = %', (d->'rooms'->0)->'roomMuted';
  raise notice '② room.mute 权限点存在 = %',
    exists(select 1 from acl_perm_label where key='room.mute');
  -- 解除
  perform room_mute(rid, uid, 0);
  d := state_delta(0)::jsonb;
  raise notice '③ 解禁后 roomMuted = %', (d->'rooms'->0)->'roomMuted';
  raise notice '④ room_mute 签名数 = %',
    (select count(*) from pg_proc where proname='room_mute');
end $$;
rollback;
