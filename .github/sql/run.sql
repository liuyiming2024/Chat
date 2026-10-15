-- 端到端验证（第二轮）：修正上一轮的错判
-- 上一轮 ⑧ 用 count(*) 判删除，得出"没删掉" —— 那是**我的断言写错了**：
-- messages.deleted 是逻辑删除标记，count(*) 本来就不会变。
-- 这一轮改判 deleted 标记 + rev 是否 bump + 增量里能否取到删除态。
begin;
set local request.headers = '{"x-session": "e2e-probe-token"}';
insert into sessions (token_hash, user_id, expires_at)
select encode(digest('e2e-probe-token','sha256'),'hex'), u.id, now() + interval '1 hour'
from users u where u.status='active' limit 1;

do $$
declare rid text; mid text; rev0 bigint; rev1 bigint; rev2 bigint; d json;
        del_flag boolean; dbody text;
begin
  select id into rid from rooms limit 1;
  rev0 := state_peek();

  select (msg_send(rid,'text','撤回同步验证'))::json->>'id' into mid;
  rev1 := state_peek();
  raise notice '① 发送后 rev % -> %', rev0, rev1;

  -- 撤回
  perform msg_delete(mid::uuid);
  rev2 := state_peek();
  raise notice '② 撤回后 rev % -> %（必须再涨，否则别的设备不知道被撤了）', rev1, rev2;

  select deleted, body into del_flag, dbody from messages where id = mid::uuid;
  raise notice '③ deleted=%, body=%（逻辑删除：行还在、内容清空）', del_flag, coalesce(dbody,'(空)');

  -- 从"发送之前"的位置拉增量，看能不能拿到这条被撤的消息
  d := state_delta(rev0);
  raise notice '④ 增量里能取到这条 = %',
    case when d::text like '%撤回同步验证%' then '是' else '❌ 否' end;
end $$;
rollback;

select count(*)::text as 回滚后消息数 from messages;
