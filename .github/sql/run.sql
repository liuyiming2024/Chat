/* V-03 实测：新建一个函数，anon 会不会自动获得执行权？
   这才是"grant execute on all functions"那条语句真正的危害所在 ——
   不是旧函数，而是**今后每一个新建的函数**。 */
create or replace function _v03_probe() returns int
language sql stable as $$ select 42 $$;

select count(*) as anon能否执行新函数 from (
  select 1 from information_schema.role_routine_grants
   where routine_name='_v03_probe'
     and grantee='anon' and privilege_type='EXECUTE') t;

select count(*) as public能否执行 from (
  select 1 from information_schema.role_routine_grants
   where routine_name='_v03_probe'
     and grantee='PUBLIC' and privilege_type='EXECUTE') t;

/* 对照：一个已存在的对外函数，应当仍对 anon 开放（白名单生效） */
select count(*) as 白名单函数whoami_anon可执行 from (
  select 1 from information_schema.role_routine_grants
   where routine_name='whoami' and grantee='anon') t;

/* 统计当前 anon 能执行多少个函数 */
select count(distinct routine_name) as anon可执行函数总数
  from information_schema.role_routine_grants
 where grantee='anon' and privilege_type='EXECUTE'
   and routine_schema='public';

drop function _v03_probe();
