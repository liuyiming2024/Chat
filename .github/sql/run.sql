-- 第三轮：上一轮我又错了一次 —— 撤回会把 body 清空，
-- 所以按正文找当然找不到。要按 id 找，并看 deleted 标记有没有带出来。
begin;
set local request.headers = '{"x-session": "e2e-probe-token"}';
insert into sessions (token_hash, user_id, expires_at)
select encode(digest('e2e-probe-token','sha256'),'hex'), u.id, now() + interval '1 hour'
from users u where u.status='active' limit 1;

do $$
declare rid text; mid text; rev0 bigint; d text; pos int;
begin
  select id into rid from rooms limit 1;
  rev0 := state_peek();
  select (msg_send(rid,'text','撤回同步验证'))::json->>'id' into mid;
  perform msg_delete(mid::uuid);

  d := state_delta(rev0)::text;
  pos := position(mid in d);
  raise notice '① 增量里能否找到该消息 id = %', case when pos > 0 then '是' else '❌ 否' end;
  if pos > 0 then
    raise notice '② 该消息在增量里的片段 = %', substr(d, greatest(pos-160,1), 320);
  else
    raise notice '② 增量全文长度 = %，前 300 字符 = %', length(d), left(d,300);
  end if;

  -- 对照：撤回「之前」的增量（此时还没删），应当能取到
  raise notice '③ 对照：state_delta 的顶层键 = %',
    (select string_agg(k, ',') from json_object_keys(state_delta(rev0)::json) k);
end $$;
rollback;
