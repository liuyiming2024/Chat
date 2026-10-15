-- 找权限相关的表与函数签名
select table_name from information_schema.tables
 where table_name like '%acl%' or table_name like '%perm%' or table_name like '%role%'
 order by table_name;

select p.proname, pg_get_function_arguments(p.oid) as args
  from pg_proc p where p.proname like '%acl%' or p.proname like '%perm%'
 order by p.proname;
