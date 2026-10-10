-- 列出所有 public 函数的：名字 | 参数 | 返回类型
-- 用来和 schema.sql 对比，找出"同名同参但返回类型不同"的致命冲突
select p.proname || ' | ' || pg_get_function_identity_arguments(p.oid)
       || ' => ' || pg_get_function_result(p.oid) as sig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.proname;
