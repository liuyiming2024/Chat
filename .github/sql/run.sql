-- Archive 迁移前体检（第二轮）：权限点表是否存在、owner 现有权限
select 'acl_perm_label表' as item, count(*)::text as n
  from information_schema.tables where table_name='acl_perm_label'
union all select 'acl_role_perms表', count(*)::text
  from information_schema.tables where table_name='acl_role_perms'
union all select '只读模式下不能写，仅确认结构', 'ok';

-- owner 角色当前持有哪些权限点（看 site.profile 是否已登记）
select role, perms from acl_role_perms where role in ('owner','admin') limit 5;
