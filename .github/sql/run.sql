/* S-137 验证（只读） */
select state_get() as 未登录全量;
select state_delta(0) as 未登录增量;
select count(*) filter (where has_function_privilege('anon',p.oid,'execute')) as anon可执行,
       count(*) as 总数
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';
select p.proname, has_function_privilege('anon',p.oid,'execute') as anon_can
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('cur_user','auth_uid','new_token','state_get','user_login','site_ready')
order by p.proname;
