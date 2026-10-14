-- 临时排查：定位 schema.sql 迁移失败点（用完立即清空）
\echo '=== invite 相关函数 ==='
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'invite%'
order by p.proname, args;

\echo '=== session_cleanup / cur_user ==='
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('session_cleanup','cur_user','acl_require');

\echo '=== invites 表结构 ==='
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='invites' order by ordinal_position;

\echo '=== 最近错误线索：对象计数 ==='
select 'invites rows' as k, count(*)::text as v from invites
union all select 'rooms', count(*)::text from rooms;
