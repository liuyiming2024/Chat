/* 验证 default privileges：新建函数应不再对 anon 开放 */
create or replace function _v03_probe2() returns int
language sql stable security invoker as $$ select 42 $$;

\echo '--- ① anon 执行新建函数（期望：permission denied）---'
set role anon;
select _v03_probe2() as 结果;
reset role;

\echo '--- ② postgres 自己执行（期望：正常，别把自己也锁外面）---'
select _v03_probe2() as postgres执行;

\echo '--- ③ 白名单函数仍应对 anon 可用（对照）---'
set role anon;
select site_info() is not null as site_info可执行;
reset role;

drop function _v03_probe2();

\echo '--- ④ default privileges 已记录 ---'
select coalesce(array_to_string(defaclacl,','),'(空)') as postgres默认函数权限
  from pg_default_acl
 where defaclnamespace='public'::regnamespace
   and defaclrole='postgres'::regrole and defaclobjtype='f';
