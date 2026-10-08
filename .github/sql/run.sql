\echo '===== users 列 ====='
select string_agg(column_name,' , ' order by ordinal_position) from information_schema.columns
where table_schema='public' and table_name='users';

\echo '===== rooms 列 ====='
select string_agg(column_name,' , ' order by ordinal_position) from information_schema.columns
where table_schema='public' and table_name='rooms';

\echo '===== room_admins 列 ====='
select string_agg(column_name,' , ' order by ordinal_position) from information_schema.columns
where table_schema='public' and table_name='room_admins';

\echo '===== room_members 列 ====='
select string_agg(column_name,' , ' order by ordinal_position) from information_schema.columns
where table_schema='public' and table_name='room_members';

\echo '===== perms 列类型 ====='
select column_name, data_type, udt_name from information_schema.columns
where table_schema='public' and table_name='users' and column_name in ('perms','role','status','muted_until');
