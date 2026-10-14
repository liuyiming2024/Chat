-- 临时排查（用完即清）
\echo '=== invite 函数 ==='
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public' and p.proname like 'invite%' order by p.proname, args;
\echo '=== user_register 是否含 S-100 校验（看函数体长度变化）==='
select proname, length(prosrc) as srclen from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and proname in ('user_register','session_cleanup','invite_list');
