-- 更换已泄露的密码（旧密码曾出现在公开仓库的 git 历史里）。
-- 用 DO 块执行，不回显任何 token。
do $$
begin
  update site set gate_hash = crypt('omuAS6QbcP', gen_salt('bf', 10)) where id = true;
  update users  set pwd_hash = crypt('bH5TPdrAFsu74M', gen_salt('bf', 10))
  where role = 'owner';
  -- 旧会话全部失效，强制重新登录
  delete from sessions;
  raise notice '密码已更换，旧会话已清空';
end $$;

\echo '===== 验证 ====='
select site_ready() as 站点已初始化,
       (select count(*) from users where role='owner') as 站长数,
       (select count(*) from sessions) as 会话数;

\echo '===== 用新密码过门禁（不回显 token）====='
do $$
declare t text;
begin
  select gate_check('omuAS6QbcP') into t;
  raise notice '门禁通过，token 长度 %（已丢弃）', length(t);
end $$;
