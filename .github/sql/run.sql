-- 模拟前端在线模式的完整调用序列（不写任何密码，用现存值验证链路）
\echo '===== 1. site_ready（前端 probe 第一步）====='
select site_ready() as 站点已初始化;

\echo '===== 2. state_peek（轮询用，不应改变序号）====='
select state_peek() as peek1;
select state_peek() as peek2_应与上相同;

\echo '===== 3. gate_check → 拿会话（token 已丢弃）====='
do $$
declare t text;
begin
  select gate_check('omuAS6QbcP') into t;
  perform set_config('request.headers', json_build_object('x-session', t)::text, false);
  raise notice '过门禁，token 长度 %', length(t);
end $$;

\echo '===== 4. state_get（前端拉全量）====='
do $$
declare j json; n int;
begin
  select state_get() into j;
  n := json_array_length(coalesce(j->'messages','[]'::json));
  raise notice '拉取成功：用户%人 房间%个 消息%条',
    json_array_length(coalesce(j->'users','[]'::json)),
    json_array_length(coalesce(j->'rooms','[]'::json)), n;
end $$;

\echo '===== 5. 未登录时 state_get 能否拿到数据（应可，仅过门禁）====='
do $$
declare j json;
begin
  select state_get() into j;
  raise notice 'me=% (未登录应为 null)', (j->>'me')::text;
end $$;

\echo '===== 6. 未登录发消息（应被拒）====='
do $$
begin
  begin
    perform msg_send('public','text','hack');
    raise notice '★未登录也能发消息——漏洞';
  exception when others then
    raise notice '已拦截: %', SQLERRM;
  end;
end $$;
