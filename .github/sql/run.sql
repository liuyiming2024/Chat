select coalesce(string_agg(table_name,', ' order by table_name),'（无）') as code_tables
from information_schema.tables
where table_schema='public' and table_name like 'code_%';
select coalesce(string_agg(routine_name,', ' order by routine_name),'（无）') as code_funcs
from information_schema.routines
where routine_schema='public' and routine_name like 'code_%';
