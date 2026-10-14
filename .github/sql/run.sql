-- 临时验证（用完即清）
\echo '=== invite 函数签名 ==='
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname like 'invite%' order by p.proname;
\echo '=== 补列是否到位 ==='
select table_name,column_name from information_schema.columns
where table_schema='public' and ((table_name='messages' and column_name='edited_at')
   or (table_name='logs' and column_name='rev'));
\echo '=== user_register 是否含 S-100 校验 ==='
select case when prosrc like '%chr(8203)%' then 'S-100 已生效' else 'S-100 未生效' end as s100,
       case when prosrc like '%add column%' then '' else '' end
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and proname='user_register';
\echo '=== session_cleanup 是否含 invites 清理 ==='
select case when prosrc like '%delete from invites%' then 'INV-RELEASE 清理已生效' else '未生效' end
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and proname='session_cleanup';
