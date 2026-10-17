/* 核实：git 历史里泄露的站长密码是否仍然有效（3f70c6c7 出现于 2026-10-08） */
begin;
do $$
declare r json;
begin
  select auth_login('站长','bH5TPdrAFsu74M') into r;
  raise notice '① ★泄露的站长密码登录结果 = %', r::text;
exception when others then
  raise notice '① 登录函数签名不同或失败：%', SQLERRM;
end $$;
rollback;
