\echo '===== 所有叫 sessions 的表（含 schema）====='
select table_schema, table_name from information_schema.tables
where table_name='sessions' order by 1;

\echo '===== 只看 public.sessions ====='
select string_agg(column_name, ', ' order by ordinal_position) as 列
from information_schema.columns
where table_schema='public' and table_name='sessions';

\echo '===== public.sessions 主键 ====='
select kcu.column_name as 主键列
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_name=tc.constraint_name and kcu.table_schema=tc.table_schema
where tc.table_schema='public' and tc.table_name='sessions' and tc.constraint_type='PRIMARY KEY';

\echo '===== users 表关键列 ====='
select string_agg(column_name, ', ' order by ordinal_position) as 列
from information_schema.columns
where table_schema='public' and table_name='users';

\echo '===== site 表列 ====='
select string_agg(column_name, ', ' order by ordinal_position) as 列
from information_schema.columns
where table_schema='public' and table_name='site';
