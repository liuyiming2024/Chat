select current_user as 当前角色, session_user as 会话角色;
select rolname from pg_roles where rolname in ('postgres','anon','authenticated','service_role');
/* 现有 default privileges 是什么 */
select coalesce(defaclrole::regrole::text,'-') as 角色,
       defaclobjtype as 对象类型,
       coalesce(array_to_string(defaclacl,','),'(空)') as 默认权限
  from pg_default_acl
 where defaclnamespace = 'public'::regnamespace;
