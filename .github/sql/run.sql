/* S-127 验证：造一个 admin，实测档案权限点是否真的生效 */
begin;
do $$
declare v_admin uuid; v_mnick text; v_tok text;
begin
  raise notice '① site_perms 有 site.profile = %',
    (select count(*) from site_perms where key='site.profile');
  raise notice '② site_perms 还有 archive.read 吗 = %（应 0）',
    (select count(*) from site_perms where key='archive.read');

  insert into users (nick, pwd_hash, role, status)
  values ('_e2e_a_' || substr(md5(random()::text),1,6), 'x', 'admin', 'active')
  returning id, nick into v_admin, v_mnick;

  v_tok := 'e2e_a_' || md5(random()::text);
  insert into sessions (token_hash, user_id, expires_at)
  values (encode(digest(v_tok,'sha256'),'hex'), v_admin, now() + interval '1 hour');
  perform set_config('request.headers',
    json_build_object('x-session', v_tok)::text, true);

  raise notice '③ admin 查 site.profile（默认只 owner）= %（应 f）', acl_can('site.profile');
  raise notice '④ acl_why = %（应 no）', acl_why('site.profile');

  -- 站长来，验证 owner 仍放行
  declare v_oid uuid; v_otok text;
  begin
    select id into v_oid from users where role='owner' limit 1;
    v_otok := 'e2e_o_' || md5(random()::text);
    insert into sessions (token_hash, user_id, expires_at)
    values (encode(digest(v_otok,'sha256'),'hex'), v_oid, now() + interval '1 hour');
    perform set_config('request.headers',
      json_build_object('x-session', v_otok)::text, true);
    raise notice '⑤ owner 查 site.profile = %（应 t）', acl_can('site.profile');
    raise notice '⑥ owner acl_why = %（应 ok）', acl_why('site.profile');
  end;
end $$;
rollback;
