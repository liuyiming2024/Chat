-- 只读核对：Code 云盘的表与函数是否已就位
select 'code_files 表' as 项,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='code_files')
       then '存在' else '缺失' end as 状态
union all
select '函数数量', count(*)::text from information_schema.routines
  where routine_schema='public' and routine_name like 'code_%'
union all
select 'users 表仍在', count(*)::text from users;
