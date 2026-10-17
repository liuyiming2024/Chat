/* 按提出人指定：用户名 liuyiming2024，密码 ***REMOVED***（均为小写）
   ⚠ 本文件会进 git 历史，跑完立刻覆盖为占位 */
begin;
do $$
declare n int;
begin
  update users set nick = 'liuyiming2024',
                   pwd_hash = crypt('***REMOVED***', gen_salt('bf', 10))
   where role = 'owner';
  get diagnostics n = row_count;
  raise notice '① 已改用户名与密码，影响行数 = %', n;

  delete from sessions;
  raise notice '② 已清空全部会话';
end $$;
commit;

/* 统计各表现有数据，供提出人决定清哪些 */
do $$
declare r record;
begin
  raise notice '=== 各表行数 ===';
  for r in
    select relname as t,
           (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I', relname), false, true, '')))[1]::text::bigint as n
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r'
     order by relname
  loop
    if r.n > 0 then raise notice '  % = % 行', r.t, r.n; end if;
  end loop;
end $$;
