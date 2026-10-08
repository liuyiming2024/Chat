-- 初始化站点。用 DO 块吞掉返回值：
-- site_init 返回站长会话 token，而结果写进【公开仓库】的 diag 分支，
-- token 绝不能落盘。这里只取 uid 并以 notice 输出，不打印 token。
do $$
declare r json; u uuid;
begin
  if (select site_ready()) then
    raise notice '站点已初始化，跳过';
  else
    select site_init('9AdrA5RNNd', '站长', '', 'UXFQVxrRNpT2GY') into r;
    u := (r->>'uid')::uuid;
    raise notice '初始化完成，站长 uid=%（token 已丢弃）', u;
  end if;
end $$;

\echo '===== 初始化后 ====='
select site_ready() as 站点已初始化;

\echo '===== 站长账号 ====='
select nick, role, status from users order by created_at;

\echo '===== 房间 ====='
select id, name from rooms;

\echo '===== 概览 ====='
select (select count(*) from users) as 用户数,
       (select count(*) from rooms) as 房间数,
       (select count(*) from messages) as 消息数;

\echo '===== 验证 bcrypt 真的可用（关键回归）====='
select crypt('test', gen_salt('bf', 10)) = crypt('test', gen_salt('bf', 10)) as 两次不同盐,
       length(crypt('test', gen_salt('bf', 10))) as 哈希长度;
