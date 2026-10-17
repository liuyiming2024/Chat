/* Q-Chat-S-124：验证跨项目权限端点 */
do $$
declare n int; r text; uid uuid;
begin
  raise notice '① site_perms 行数 = %（应 6）',
    (select count(*) from site_perms);
  raise notice '② 按项目分组 = %',
    (select string_agg(distinct project, ',') from site_perms);

  raise notice '③ site_can 重载数 = %（必须 1）',
    (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='site_can');

  select id into uid from users where role='owner' limit 1;
  raise notice '④ 站长 drive.use = %（应 ok）', site_can('drive.use', uid);
  raise notice '⑤ 不存在的权限点 = %（应 unknown）', site_can('nope.xyz', uid);
  raise notice '⑥ 空用户 = %（应 unknown）', site_can('drive.use', null);
  raise notice '⑦ nickname 版 = %',
    site_can_nick('drive.use', (select nick from users where role='owner' limit 1));
  raise notice '⑧ 不存在的昵称 = %（应 no_user）', site_can_nick('drive.use','___没人___');
  raise notice '⑨ 未登录 listPerms = %', site_perms_list()::text;
end $$;
