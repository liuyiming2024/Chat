/* 查权限点漂移：Archive 检查 site.profile，集群层注册表里却是 archive.read */
do $$
declare v_admin uuid := null; v_tok text; n int;
begin
  raise notice '① site_perms 里有 site.profile 吗 = %',
    (select count(*) from site_perms where key='site.profile');
  raise notice '② site_perms 里有 archive.read 吗 = %',
    (select count(*) from site_perms where key='archive.read');
  raise notice '③ acl_perm_label 里有 site.profile 吗 = %',
    (select count(*) from acl_perm_label where key='site.profile');

  select id into v_admin from users where role='admin' limit 1;
  if v_admin is null then
    raise notice '④ 线上没有 admin 账号，无法实测';
  else
    v_tok := 'e2e_drift_' || md5(random()::text);
    insert into sessions (token_hash, user_id, expires_at)
    values (encode(digest(v_tok,'sha256'),'hex'), v_admin, now() + interval '1 hour');
    perform set_config('request.headers',
      json_build_object('x-session', v_tok)::text, true);
    raise notice '④ admin 查 site.profile（Archive 真正检查的）= %', acl_can('site.profile');
    raise notice '⑤ admin 查 archive.read（注册表里配了的）= %', acl_can('archive.read');
  end if;
end $$;
