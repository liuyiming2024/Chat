-- 验证 state_delta 是否真的回传 rev。
-- ⚠ state_delta 要求已通过站点保护密码，所以必须造临时会话。
--   全部包在事务里最后 rollback，不留痕迹。
-- ⚠ 上一版我误判了机制：以为"可写模式会忽略 run.sql 去跑 schema.sql"。
--   实测不是 —— workflow 只跑 run.sql，模式只决定权限。
--   真正的差异是：当时 run.sql 里的内容就是 schema.sql（我自己 cp 过去的）。
begin;
set local request.headers = '{"x-session": "e2e-probe-token"}';
insert into sessions (token_hash, user_id, expires_at, gate_ok)
select encode(digest('e2e-probe-token','sha256'),'hex'), u.id, now() + interval '1 hour', true
from users u where u.status='active' limit 1;

do $$
declare d jsonb;
begin
  d := state_delta(0)::jsonb;
  raise notice '① users[0] 带 rev = %', (d->'users'->0) ? 'rev';
  raise notice '   users[0].rev = %', (d->'users'->0)->>'rev';
  raise notice '② rooms[0] 带 rev = %', (d->'rooms'->0) ? 'rev';
  raise notice '   rooms[0].rev = %', (d->'rooms'->0)->>'rev';
end $$;
rollback;
