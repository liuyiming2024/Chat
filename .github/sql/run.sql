-- 初始化站点。用 DO 块吞掉返回值：
-- site_init 会返回站长会话 token，而结果会写进【公开仓库】的 diag 分支，
-- token 绝不能落到公开仓库里。这里只取 uid，并且不打印 token。
do $$
declare r json; u uuid;
begin
  if (select site_ready()) then
    raise notice '站点已初始化，跳过';
  else
    select site_init('9AdrA5RNNd', '站长', '', 'UXFQVxrRNpT2GY') into r;
    u := (r->>'uid')::uuid;
    raise notice '初始化完成，站长 uid=%（token 已丢弃，不落盘）', u;
  end if;
end $$;

\echo '===== 初始化后状态 ====='
select site_ready() as 站点已初始化;

\echo '===== 站长账号 ====='
select nick, role, status from users order by created_at;

\echo '===== 公屏大厅是否已建 ====='
select id, name from rooms;

\echo '===== 数据概览 ====='
select (select count(*) from users) as 用户数,
       (select count(*) from rooms) as 房间数,
       (select count(*) from messages) as 消息数;
