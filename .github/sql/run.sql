create or replace function _v03_probe3() returns int
language sql stable security invoker as $$ select 42 $$;

/* has_function_privilege 会考虑所有继承路径，是唯一可信的判断 */
select has_function_privilege('anon','_v03_probe3()','EXECUTE') as anon是否有权,
       has_function_privilege('public','_v03_probe3()','EXECUTE') as public是否有权;

/* anon 属于哪些角色（继承路径） */
select r.rolname as 成员, g.rolname as 属于
  from pg_auth_members m
  join pg_roles r on r.oid=m.member
  join pg_roles g on g.oid=m.roleid
 where r.rolname='anon';

/* 这条新函数的 ACL 具体是什么 */
select proname, proacl from pg_proc where proname='_v03_probe3';

drop function _v03_probe3();
