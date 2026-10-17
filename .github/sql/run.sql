/* S-127 关键验证：在权限页给 admin 开档案权限后，是否真的生效。
   上一轮 archive.read 是假权限点 —— 配了 Archive 也不检查。 */
begin;
do $$
declare v_admin uuid; v_tok text;
begin
  insert into users (nick, pwd_hash, role, status)
  values ('_e2e_a_' || substr(md5(random()::text),1,6), 'x', 'admin', 'active')
  returning id into v_admin;
  v_tok := 'e2e_a_' || md5(random()::text);
  insert into sessions (token_hash, user_id, expires_at)
  values (encode(digest(v_tok,'sha256'),'hex'), v_admin, now() + interval '1 hour');
  perform set_config('request.headers',
    json_build_object('x-session', v_tok)::text, true);

  raise notice '① 开权限前 admin = %（应 f）', acl_can('site.profile');

  /* 模拟权限页操作：把这个权限点开放给 admin */
  update site_perms set default_roles = array['owner','admin']
   where key = 'site.profile';

  raise notice '② 开放后 admin = %（应 t —— 配了就真生效）', acl_can('site.profile');
  raise notice '③ acl_why = %（应 ok）', acl_why('site.profile');

  /* 闸门实测：Archive 的 profile_list 会不会放行 */
  begin
    perform acl_require('site.profile');
    raise notice '④ 闸门放行 ✓';
  exception when others then
    raise notice '④ 闸门拦住：%', SQLERRM;
  end;
end $$;
rollback;
