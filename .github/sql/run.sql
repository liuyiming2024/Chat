do $outer$
declare r json; u1 uuid; st text;
begin
  select id, status into u1, st from users where nick='测试账号一';
  raise notice '① 测试账号一 status = %', st;
  select user_login('测试账号一','test1234') into r;
  raise notice '② 登录结果 = %', r::text;
end $outer$;
