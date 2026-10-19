/* V-03 严格复验 —— 顶层语句，不做嵌套 do 块（上一轮那个写法报语法错）。
   唯一可信的验证：真的切到 anon 角色去执行一次。 */
create or replace function _v03_probe() returns int
language sql stable security invoker as $$ select 42 $$;

\echo '--- ① 切到 anon，执行新建函数（期望：报 permission denied）---'
set role anon;
select _v03_probe() as anon执行新建函数;
reset role;

\echo '--- ② 对照组：白名单函数 site_ready（期望：正常执行）---'
set role anon;
select site_ready() as anon执行白名单函数;
reset role;

\echo '--- ③ 顺带看 anon 能否读到用户表（期望：被拒）---'
set role anon;
select count(*) as anon读users from users;
reset role;

drop function _v03_probe();
