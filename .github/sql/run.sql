/* 落实清空：只清使用期流水，不动配置元数据 */
begin;
delete from login_attempts;
delete from logs;
delete from messages;
delete from media_objects;
delete from invites;
delete from bridge_ticket;
commit;
do $$
begin
  raise notice '① login_attempts = %', (select count(*) from login_attempts);
  raise notice '② logs = %', (select count(*) from logs);
  raise notice '③ 配置仍在：site_perms=% acl_perm_label=% users=% rooms=%',
    (select count(*) from site_perms), (select count(*) from acl_perm_label),
    (select count(*) from users), (select count(*) from rooms);
  raise notice '④ 站长用户名 = %', (select nick from users where role='owner');
end $$;
