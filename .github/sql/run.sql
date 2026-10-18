/* S-136 验证（只读）*/
select p.proname as fn,
       has_function_privilege('anon', p.oid, 'execute') as anon_can
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in ('cur_user','auth_uid','auth_require','new_token','cur_token',
                    'login_attempts_cleanup','issue_session','acl_role_perms',
                    'user_login','msg_send','state_get','whoami','site_info',
                    'room_dm','room_leave','gate_check','site_ready','user_register')
order by p.proname;
select count(*) filter (where has_function_privilege('anon',p.oid,'execute')) as anon可执行,
       count(*) as 总数
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';
