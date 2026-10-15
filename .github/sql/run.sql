-- Archive 迁移后验证
select table_name from information_schema.tables
 where table_name like 'profile%' order by table_name;

select count(*)::text as 函数数 from pg_proc where proname like 'profile%' or proname like 'journal%';

select key, value from acl_perm_label where key='site.profile';
