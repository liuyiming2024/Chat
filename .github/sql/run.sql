/* V-03 严格复验。
   ⚠ 上一轮我查 information_schema.role_routine_grants 得 anon=0，
     差点据此下结论"新函数不会自动开放"。但那个视图**只显示直接授予**，
     不显示通过 PUBLIC 继承的权限 —— anon=0 不代表 anon 执行不了。
     用视图判断权限，等于用"没被点名"证明"没有权限"，是错的。

   ★ 唯一可信的验证：真的切到 anon 角色去执行一次。 */
create or replace function _v03_probe() returns int
language sql stable security invoker as $$ select 42 $$;

do $$
declare ok boolean := false; msg text;
begin
  set role anon;
  begin
    perform _v03_probe();
    ok := true;
  exception when others then
    msg := SQLERRM;
  end;
  reset role;
  if ok then
    raise notice '❌ anon 能执行新建函数 —— 新函数仍会自动对匿名开放（V-03 未修）';
  else
    raise notice '✅ anon 执行被拒：% —— 新函数不会自动开放', coalesce(msg,'(无信息)');
  end;
end $$;

/* 对照：白名单里的函数，anon 应当能执行（否则白名单失效） */
do $$
declare ok boolean := false; msg text;
begin
  set role anon;
  begin
    perform site_ready();
    ok := true;
  exception when others then msg := SQLERRM;
  end;
  reset role;
  if ok then raise notice '✅ 对照组：白名单函数 site_ready anon 可执行';
  else raise notice '❌ 白名单失效：site_ready 也被拒 —— %', coalesce(msg,'');
  end if;
end $$;

drop function _v03_probe();
