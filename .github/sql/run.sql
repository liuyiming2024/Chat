/* Q-Site-S-121：验证 whoami() 已建且行为正确。 */
do $$
declare r jsonb;
begin
  raise notice '① whoami 重载数 = %（必须为 1，>1 说明 create or replace 没替换掉旧签名）',
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='whoami');

  raise notice '② 未登录调用 = %', whoami()::text;

  raise notice '③ 权限 = %',
    (select count(*) from information_schema.routine_privileges
      where routine_name='whoami' and grantee in ('anon','authenticated'));
end $$;
