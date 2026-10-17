/* Q-Chat-S-125：验证统一 ACL 闸门 */
do $$
declare uid uuid; n int;
begin
  raise notice '① acl_can 重载数 = %（必须 1 —— >1 说明 drop 没生效）',
    (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='acl_can');
  raise notice '② acl_require 重载数 = %（必须 1）',
    (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='acl_require');

  select id into uid from users where role='owner' limit 1;

  -- 二餐兼容：老的两参数调用必须还能用
  raise notice '③ 二餐 acl_can(perm, room) = %', acl_can('msg.send', null);
  -- 三餐：查指定用户
  raise notice '④ 三餐 acl_can(perm, room, user) = %', acl_can('drive.use', null, uid);
  raise notice '⑤ acl_why 跨项目 = %（应 ok）', acl_why('drive.use', null, uid);
  raise notice '⑥ acl_why 拼错 = %（应 unknown）', acl_why('nope.xyz', null, uid);
  raise notice '⑦ site_perms 含 scope 列 = %',
    (select count(*) from information_schema.columns
      where table_name='site_perms' and column_name='scope');
  raise notice '⑧ acl_perms_list 未登录 = %', acl_perms_list()::text;
end $$;

-- 闸门实测：造一个会被拒的场景，确认真的 raise exception
do $$
begin
  begin
    perform acl_require('drive.use');   -- 未登录：必须先登录
    raise notice '⑨ 闸门未拦住（不该出现）';
  exception when others then
    raise notice '⑨ 闸门已拦住：%', SQLERRM;
  end;
end $$;
