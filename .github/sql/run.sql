/* S-136 验证：白名单是否生效（只读，不涉及任何凭据） */
select p.proname as fn,
       pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('anon', p.oid, 'execute') as anon_can,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_can
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('cur_user','auth_uid','auth_require','user_login','msg_send',
                    'state_get','whoami','site_info','acl_can','acl_why',
                    'login_attempts_cleanup','new_token','gate_check','room_dm')
order by p.proname;

select count(*) filter (where has_function_privilege('anon', p.oid, 'execute')) as anon_可执行函数数,
       count(*) as 函数总数
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public';
