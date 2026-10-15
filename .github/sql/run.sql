-- ============================================================
-- Chat 核心链路端到端验证：「消息能存能取」
-- 全部在一个事务里，最后 rollback —— 测试完不留任何痕迹。
-- 做法：临时插一条会话 → 调 msg_send → 用 state_peek/state_delta 取回。
-- ============================================================
begin;

set local request.headers = '{"x-session": "e2e-probe-token"}';

insert into sessions (token_hash, user_id, expires_at)
select encode(digest('e2e-probe-token','sha256'), 'hex'), u.id, now() + interval '1 hour'
from users u where u.status = 'active' limit 1;

do $$
declare
  rid text; uid uuid; mid text; n0 int; n1 int;
  rev0 bigint; rev1 bigint; d json; got text;
begin
  select id into rid from rooms limit 1;
  uid := cur_user();
  raise notice '① cur_user() = %（不为 null 才说明会话生效）', coalesce(uid::text,'NULL');

  select count(*) into n0 from messages;
  rev0 := state_peek();

  select (msg_send(rid,'text','E2E链路验证消息'))::json->>'id' into mid;
  raise notice '② msg_send 返回 id = %', coalesce(mid,'NULL');

  select count(*) into n1 from messages;
  raise notice '③ 消息数 % -> %（+1 才叫存进去了）', n0, n1;

  select body into got from messages where id = mid::uuid;
  raise notice '④ 直接读回 = %', coalesce(got,'(读不到)');

  rev1 := state_peek();
  raise notice '⑤ state_peek % -> %（必须变大，否则客户端不知道有新消息）', rev0, rev1;

  d := state_delta(rev0);
  raise notice '⑥ state_delta 增量里含这条 = %',
    case when d::text like '%E2E链路验证消息%' then '是' else '❌ 否' end;

  raise notice '⑦ msg_edit 后 edited_at = %',
    coalesce((select edited_at::text from messages where id = mid::uuid),'(null)');
  perform msg_edit(mid::uuid, 'E2E改后内容');
  raise notice '   改后 body = %',
    coalesce((select body from messages where id = mid::uuid),'(null)');
  raise notice '   改后 edited_at = %',
    coalesce((select edited_at::text from messages where id = mid::uuid),'(null)');

  perform msg_delete(mid::uuid);
  raise notice '⑧ msg_delete 后剩余消息数 = %', (select count(*) from messages);
end $$;

rollback;

-- 回滚后确认零残留
select count(*)::text as 回滚后消息数 from messages;
select count(*)::text as 回滚后会话数 from sessions where token_hash = encode(digest('e2e-probe-token','sha256'),'hex');
