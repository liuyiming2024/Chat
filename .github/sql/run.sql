-- 临时：给 Code 仓库的迁移建一个专用角色。
-- 不动 postgres 主密码 —— 改主密码会让 Chat 的 Secret 立刻失效，
--  而这个库现在只有 Chat 在连，断了就是全站断。
-- 建专用角色是零风险的：成了 Code 能连，不成也不影响任何人。
do $$
begin
  if not exists (select 1 from pg_roles where rolname='code_mig') then
    execute format('create role code_mig with login password %L superuser', 'VTwxSaWFS9FELlXq8YsQcgerRukU');
  else
    execute format('alter role code_mig with login password %L superuser', 'VTwxSaWFS9FELlXq8YsQcgerRukU');
  end if;
end
$$;
select rolname, rolsuper from pg_roles where rolname='code_mig';
