/* Q-Chat-S-123：验证集群层账号端点 */
do $$
declare n int; r text; c int;
begin
  select count(*) into c from information_schema.columns
   where table_name='users' and column_name='avatar';
  raise notice '① users.avatar 列存在 = %', c;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public' and p.proname='profile_update';
  raise notice '② profile_update 重载数 = %（必须 1，>1 说明 drop 没生效）', n;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public' and p.proname='user_list';
  raise notice '③ user_list 重载数 = %（必须 1）', n;

  r := user_list(null)::text;
  raise notice '④ 未登录 user_list = %', r;

  raise notice '⑤ whoami 重载数 = %',
    (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='whoami');
end $$;
