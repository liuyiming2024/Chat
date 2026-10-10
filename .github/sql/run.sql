-- 确认本轮迁移是否真的进库了
select 'bridge_ticket 表' as 项,
       case when exists (select 1 from information_schema.tables
                         where table_schema='public' and table_name='bridge_ticket')
            then '存在' else '缺失' end as 状态;

select 'origin 列' as 项,
       case when exists (select 1 from information_schema.columns
                         where table_schema='public' and table_name='bridge_ticket'
                           and column_name='origin')
            then '存在' else '缺失' end as 状态;

select 'redeem 参数' as 项,
       coalesce(string_agg(pg_get_function_identity_arguments(p.oid), ' | '), '无') as 状态
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='bridge_ticket_redeem';

select 'create 参数' as 项,
       coalesce(string_agg(pg_get_function_identity_arguments(p.oid), ' | '), '无') as 状态
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='bridge_ticket_create';
