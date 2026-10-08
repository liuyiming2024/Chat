\echo '===== pgcrypto 装在哪 ====='
select e.extname, n.nspname as schema
from pg_extension e join pg_namespace n on n.oid=e.extnamespace
where e.extname in ('pgcrypto','uuid-ossp','citext');

\echo '===== gen_salt / crypt 在哪个 schema ====='
select p.proname, n.nspname
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.proname in ('gen_salt','crypt','digest','gen_random_uuid')
order by 2,1;

\echo '===== 当前 search_path ====='
show search_path;
