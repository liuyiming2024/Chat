/* Q-Chat-S-125：会话内验证 ACL 闸门。
   ⚠ sessions.token_hash 存的是 sha256(token)，不是明文 ——
     上一轮我插了明文，cur_user() 一直是 null，什么都没验到。 */
begin;
do $$
declare
  v_tok text := 'e2e_acl_' || md5(random()::text);
  v_uid uuid; v_nick text;
  v_member uuid; v_mnick text; v_mtok text;
begin
  select id, nick into v_uid, v_nick from users where role='owner' limit 1;
  raise notice '站长：%', v_nick;

  insert into sessions (token_hash, user_id, expires_at)
  values (encode(digest(v_tok,'sha256'),'hex'), v_uid, now() + interval '1 hour');
  perform set_config('request.headers',
    json_build_object('x-session', v_tok)::text, true);

  raise notice '① cur_user = %（不应为 NULL）', cur_user();
  raise notice '② 站长 drive.use → acl_can = %（应 t）', acl_can('drive.use', null, v_uid);
  raise notice '③ 站长 drive.use → acl_why = %（应 ok）', acl_why('drive.use', null, v_uid);
  raise notice '④ 拼错权限点 → %（应 unknown）', acl_why('nope.xyz', null, v_uid);
  raise notice '⑤ 二餐兼容 msg.send = %（应 t）', acl_can('msg.send', null);

  insert into users (nick, pwd_hash, role, status)
  values ('_e2e_m_' || substr(md5(random()::text),1,6), 'x', 'member', 'active')
  returning id, nick into v_member, v_mnick;

  raise notice '⑥ 成员 drive.use = %（应 f）', acl_can('drive.use', null, v_member);
  raise notice '⑦ 成员 drive.use → acl_why = %（应 no）', acl_why('drive.use', null, v_member);
  raise notice '⑧ 成员 code.run = %（应 t）', acl_can('code.run', null, v_member);

  v_mtok := 'e2e_m_' || md5(random()::text);
  insert into sessions (token_hash, user_id, expires_at)
  values (encode(digest(v_mtok,'sha256'),'hex'), v_member, now() + interval '1 hour');
  perform set_config('request.headers',
    json_build_object('x-session', v_mtok)::text, true);

  raise notice '⑨ 成员查站长权限 = %（应 f，不能枚举他人）', acl_can('drive.use', null, v_uid);
  begin
    perform acl_require('drive.use', null, v_member);
    raise notice '⑩ 闸门没拦住（不该出现）';
  exception when others then
    raise notice '⑩ 闸门已拦住：%', SQLERRM;
  end;
end $$;
rollback;
