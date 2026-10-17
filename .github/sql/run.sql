/* C-4 审计：哪些 SECURITY DEFINER 函数对 anon 开放、但函数体里没有任何权限校验 */
begin;
do $$
declare r record; n int := 0;
begin
  raise notice '=== 对 anon 开放 且 无权限校验关键词 的函数 ===';
  for r in
    select p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public'
       and p.prosecdef = true
       and exists (
         select 1 from information_schema.role_routine_grants g
          where g.grantee='anon' and g.privilege_type='EXECUTE'
            and g.routine_name = p.proname
       )
       and pg_get_functiondef(p.oid) !~* 'acl_require|auth_require|acl_can|cur_user\(\)\s*(is\s+not|<>|!=)\s*null|raise exception|perform acl_|perform auth_'
     order by p.proname
  loop
    n := n + 1;
    raise notice '  ⚠ %（% 行）', r.proname, length(r.def) - length(replace(r.def, chr(10), ''));
  end loop;
  raise notice '合计 % 个', n;
end $$;
rollback;
