/* 验证事件触发器：建函数后 PUBLIC 应被自动收回 */
create or replace function _v03_probe4() returns int
language sql stable security invoker as $$ select 42 $$;

select has_function_privilege('anon','_v03_probe4()','EXECUTE') as anon是否有权,
       proacl from pg_proc where proname='_v03_probe4';

\echo '--- 真实执行（期望：permission denied）---'
set role anon;
select _v03_probe4() as 结果;
reset role;

drop function _v03_probe4();

\echo '--- 触发器是否在线 ---'
select evtname, evtevent, evtowner::regrole as owner
  from pg_event_trigger;
