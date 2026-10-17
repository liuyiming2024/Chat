/* 核对几个名字可疑的函数，看到底有没有校验 */
begin;
do $$
declare d text;
begin
  for d in
    select pg_get_functiondef(p.oid) from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and p.proname in ('rls_auto_enable','bridge_ticket_redeem','code_me','forum_list','media_upload_allowed','site_can_nick','logout')
  loop
    raise notice '----- %', substring(d from 1 for 700);
  end loop;
end $$;
rollback;
