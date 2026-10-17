/* 直接验证 user_list 现在能不能用（不再靠迁移报告判断，那可能是旧报告） */
do $outer$
declare r json; n int;
begin
  select user_login('liuyiming2024','20120421lym') into r;
  perform set_config('request.headers', json_build_object('x-session', r->>'token')::text, true);

  select user_list() into r;
  n := json_array_length(coalesce(r->'users','[]'::json));
  raise notice '① user_list 返回用户数 = %（>0 即修好）', n;
  raise notice '② pending 数 = %',
    (select count(*) from json_array_elements(r->'users') x where x->>'status'='pending');
  raise notice '③ 能看到 待审核账号 = %', (r::text like '%待审核账号%');
  raise notice '④ 管理员能看到申请说明 = %', (r::text like '%留在队列里验证审核功能%');

  -- ★ 普通成员不能看到别人的申请说明（信息泄露防线）
  declare r2 json;
  begin
    select user_login('测试账号一','test1234') into r2;
    perform set_config('request.headers', json_build_object('x-session', r2->>'token')::text, true);
    select user_list() into r2;
    raise notice '⑤ 普通成员 user_list 用户数 = %（应 1：只能看自己）',
      json_array_length(coalesce(r2->'users','[]'::json));
    raise notice '⑥ ★普通成员看不到他人申请说明 = %',
      (not (r2::text like '%留在队列里验证审核功能%'));
  end;
end $outer$;
