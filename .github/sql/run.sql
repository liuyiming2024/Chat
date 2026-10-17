/* 站长审核：过两个，留一个在队列 */
do $outer$
declare r json; okb boolean; u1 uuid; u2 uuid; n int;
begin
  select user_login('liuyiming2024','***REMOVED***') into r;
  perform set_config('request.headers', json_build_object('x-session', r->>'token')::text, true);

  select id into u1 from users where nick='测试账号一';
  select id into u2 from users where nick='测试账号二';

  select user_review(u1,'active') into okb;
  raise notice '① 通过 测试账号一 = %', okb;
  select user_review(u2,'active') into okb;
  raise notice '② 通过 测试账号二 = %', okb;

  -- 审核队列：user_list 应只给管理员，且能看到 pending
  select user_list() into r;
  raise notice '③ 审核队列里 pending 数 = %',
    (select count(*) from json_array_elements(coalesce(r->'users','[]'::json)) x
      where x->>'status' = 'pending');
  raise notice '④ 队列里能看到 待审核账号 = %',
    (r::text like '%待审核账号%');
  raise notice '⑤ 也能看到申请说明（仅管理员） = %',
    (r::text like '%留在队列里验证审核功能%');
end $outer$;
