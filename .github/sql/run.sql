/* 紧急：轮换已泄露的站长密码 + 清空所有会话 */
begin;
do $$
declare n int;
begin
  update users set pwd_hash = crypt('2PwfO299ILDjyjnGwlXx', gen_salt('bf', 10))
   where role = 'owner';
  get diagnostics n = row_count;
  raise notice '① 已重置站长密码，影响行数 = %', n;

  delete from sessions;
  raise notice '② 已清空全部会话（泄露期间可能有人用旧密码登录过）';

  delete from login_attempts;
  raise notice '③ 已清空登录尝试记录';
end $$;

/* 验证：旧密码必须失效 */
do $$
declare r json;
begin
  select user_login('站长','bH5TPdrAFsu74M') into r;
  raise notice '④ ★旧泄露密码登录 = %（必须 false）', (r->>'ok');
exception when others then
  raise notice '④ 旧密码被拒（或触发限流）：%', SQLERRM;
end $$;
commit;
