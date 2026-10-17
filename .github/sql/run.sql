/* 为什么修了还报：查 user_list 是否在库里存在多个重载 */
do $outer$
declare r record;
begin
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args,
           (select count(*) from information_schema.role_routine_grants g
             where g.routine_name=p.proname) as grants
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='user_list'
  loop
    raise notice 'user_list(%)  重载oid=%', r.args, r.oid;
  end loop;
  raise notice '调用 user_list() 无参时，实际解析到的 oid = %',
    (select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='user_list'
        and pg_get_function_identity_arguments(p.oid) = '');
end $outer$;
