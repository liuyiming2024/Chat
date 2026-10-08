\echo '===== 1. site_ready ====='
select site_ready() as 站点已初始化;

\echo '===== 2. state_peek 不改变序号 ====='
select state_peek() as peek1, (select state_peek()) as peek2;

\echo '===== 3. 过门禁 ====='
do $$
declare t text;
begin
  select gate_check('omuAS6QbcP') into t;
  perform set_config('request.headers', json_build_object('x-session', t)::text, false);
  raise notice '门禁通过，token 已丢弃（长度 %）', length(t);
end $$;

\echo '===== 4. state_get 拉全量 ====='
do $$
declare j json;
begin
  select state_get() into j;
  raise notice '拉取成功：me=% 用户% 房间% 消息% 日志%',
    coalesce(j->>'me','null'),
    json_array_length(coalesce(j->'users','[]'::json)),
    json_array_length(coalesce(j->'rooms','[]'::json)),
    json_array_length(coalesce(j->'messages','[]'::json)),
    json_array_length(coalesce(j->'logs','[]'::json));
end $$;

\echo '===== 5. 未登录发消息应被拒 ====='
do $$
begin
  begin
    perform msg_send('public','text','hack');
    raise notice '★ 未登录能发消息 = 漏洞';
  exception when others then raise notice '已拦截: %', SQLERRM;
  end;
end $$;

\echo '===== 6. 站长登录后发消息 ====='
do $$
declare t text; j json;
begin
  select user_login('站长','bH5TPdrAFsu74M') into j;
  t := j->>'token';
  perform set_config('request.headers', json_build_object('x-session', t)::text, false);
  perform msg_send('public','text','来自服务端的测试消息');
  raise notice '站长登录并发消息成功（token 已丢弃）';
end $$;

\echo '===== 7. 消息是否真的入库 ====='
select count(*) as 消息总数 from messages;
select body as 最新消息 from messages order by created_at desc limit 1;

\echo '===== 8. acl_mine 权限表 ====='
do $$
declare j json;
begin
  select acl_mine() into j;
  raise notice '角色=% 权限点数=%', j->>'role',
    (select count(*) from json_object_keys(j->'perms'));
end $$;
