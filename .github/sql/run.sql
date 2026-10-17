/* 核实 A-1/A-2：Archive 6 张表的 RLS 状态 + anon 实际权限（同库） */
begin;
do $$
declare r record;
begin
  raise notice '=== 未启 RLS 的表 ===';
  for r in
    select c.relname from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r' and c.relrowsecurity=false
     order by c.relname
  loop
    raise notice '  ✗ %', r.relname;
  end loop;

  raise notice '=== anon 对这些表的实际权限 ===';
  for r in
    select table_name, string_agg(privilege_type,',') as p
      from information_schema.role_table_grants
     where grantee='anon' and table_schema='public'
       and table_name in ('profiles','profile_entries','profile_notes',
                          'profile_summaries','profile_media','api_tokens')
     group by table_name
  loop
    raise notice '  anon 对 % 有：%', r.table_name, r.p;
  end loop;

  raise notice '=== Archive 表当前 RLS ===';
  for r in
    select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r'
       and c.relname like 'profile%' or (c.relname='api_tokens')
     order by c.relname
  loop
    raise notice '  % RLS=%', r.relname, r.relrowsecurity;
  end loop;
end $$;
rollback;
