/* 上次审核被回滚了（同一事务内 user_list 抛异常，整批撤销）。这次重做并确认。 */
do $outer$
declare r json; okb boolean; u1 uuid; u2 uuid; st1 text; st2 text;
begin
  select user_login('liuyiming2024','20120421lym') into r;
  perform set_config('request.headers', json_build_object('x-session', r->>'token')::text, true);
  select id into u1 from users where nick='测试账号一';
  select id into u2 from users where nick='测试账号二';
  select user_review(u1,'active') into okb;
  select user_review(u2,'active') into okb;
  select status into st1 from users where id=u1;
  select status into st2 from users where id=u2;
  raise notice '① 测试账号一 status = %（应 active）', st1;
  raise notice '② 测试账号二 status = %（应 active）', st2;
  raise notice '③ 队列里仍 pending = %（应 1：待审核账号）',
    (select count(*) from users where status='pending');
  -- 确认能登录
  select user_login('测试账号一','test1234') into r;
  raise notice '④ 测试账号一 登录 = %', (r->>'ok');
end $outer$;
