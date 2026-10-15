-- acl_role_perms 是函数不是表：看它返回什么
select pg_get_functiondef(p.oid) from pg_proc p where p.proname='acl_role_perms';

-- owner 现有权限
select acl_role_perms('owner');

-- 已有权限点标签
select key, value from acl_perm_label order by key limit 40;
