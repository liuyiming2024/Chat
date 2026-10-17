/* 确认 user_list 真故障已修 + 全库再查同类写法 */
do $outer$
declare r json; bad int := 0; rec record;
begin
  select user_login('liuyiming2024','***REMOVED***') into r;
  perform set_config('request.headers', json_build_object('x-session', r->>'token')::text, true);
  begin
    select user_list() into r;
    raise notice '① ★user_list 不再抛异常，返回用户数 = %',
      json_array_length(coalesce(r->'users','[]'::json));
    raise notice '② pending 数 = %',
      (select count(*) from json_array_elements(coalesce(r->'users','[]'::json)) x
        where x->>'status'='pending');
    raise notice '③ 管理员能看到申请说明 = %', (r::text like '%留在队列里验证审核功能%');
  exception when others then
    raise notice '① user_list 仍然报错：%', SQLERRM;
  end;

  -- 全库再查：还有没有 json_agg 后直接 order by 的写法
  for rec in
    select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and pg_get_functiondef(p.oid) ~ 'json_agg'
       and pg_get_functiondef(p.oid) ~* '\)[\s\r\n]*from[\s\r\n]+\w+[\s\r\n]*\w*[\s\r\n]*order by'
  loop
    bad := bad + 1;
    raise notice '  ⚠ 同类可疑写法：%', rec.proname;
  end loop;
  raise notice '④ 同类可疑函数 = % 个', bad;
end $outer$;
