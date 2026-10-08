\echo '===== 服务端 ACL 函数 ====='
select string_agg(proname, ', ' order by proname) as acl函数
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and proname like 'acl_%';

\echo '===== 权限点总数 ====='
select count(*) as 权限点数 from acl_perm_label;

\echo '===== 未登录时查自己的权限（应报错或空）====='
do $$
begin
  begin
    perform acl_mine();
    raise notice 'acl_mine 未登录也能跑（若为真的需收紧）';
  exception when others then
    raise notice 'acl_mine 未登录时报: %', SQLERRM;
  end;
end $$;

\echo '===== 管理类函数是否已接鉴权 ====='
select p.proname as 函数,
       case when pg_get_functiondef(p.oid) like '%acl_require%' then '已接鉴权' else '★未接' end as 状态
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in ('room_delete','room_update','member_add','member_remove','member_admin',
                    'user_review','user_mute','user_role_set','user_perms_set','user_delete',
                    'gate_set','site_set','msg_send')
order by 2,1;
