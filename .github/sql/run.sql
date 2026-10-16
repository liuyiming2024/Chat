/* Q-Site-S-121：验证 whoami() */
do $$
declare n int; r text;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public' and p.proname='whoami';
  raise notice '① whoami 重载数 = %（必须 1）', n;

  r := whoami()::text;
  raise notice '② 未登录 = %', r;

  raise notice '③ 已授权给 anon/authenticated = %',
    (select count(*) from information_schema.routine_privileges
      where routine_name='whoami' and grantee in ('anon','authenticated'));
end $$;
