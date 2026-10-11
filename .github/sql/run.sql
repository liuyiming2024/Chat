\echo '--- code_ 开头的表 ---'
select table_name from information_schema.tables where table_schema='public' and table_name like 'code%' order by 1;
\echo '--- code_ 开头的函数 ---'
select routine_name from information_schema.routines where routine_schema='public' and routine_name like 'code%' order by 1;
\echo '--- 全库 public 表（前30）---'
select table_name from information_schema.tables where table_schema='public' order by 1 limit 30;
