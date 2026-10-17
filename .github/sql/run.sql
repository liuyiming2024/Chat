/* Q-Chat-S-125：在**真实会话内**验证 ACL 闸门。
   上一轮全是 no_user —— 因为迁移脚本没有登录会话，
   只验到了"未登录"这一条路径，登录后的行为根本没验到。 */
begin;
do $$
declare
  v_tok text := 'e2e_acl_' || md5(random()::text);
  v_uid uuid; v_nick text;
  v_member uuid; v_mnick text; v_mtok text;
  r boolean; w text;
begin
  select id, nick into v_uid, v_nick from users where role='owner' limit 1;
  raise notice '站长：% / %', v_nick, v_uid;

  insert into sessions (token_hash, user_id, expires_at)
  values (v_tok, v_uid, now() + interval '1 hour');
  perform set_config('request.headers',
    json_build_object('x-session', v_tok)::text, true);

  raise notice '① 会话生效：cur_user = %', cur_user();
  raise notice '② 站长 drive.use → acl_can = %（应 t）', acl_can('drive.use', null, v_uid);
  raise notice '③ 站长 drive.use → acl_why = %（应 ok）', acl_why('drive.use', null, v_uid);
  raise notice '④ 拼错的权限点 → %（应 unknown）', acl_why('nope.xyz', null, v_uid);
  raise notice '⑤ 二餐兼容 msg.send = %（应 t）', acl_can('msg.send', null);
  raise notice '⑥ 闸门放行：%', (select acl_require('drive.use'));

  -- 造一个普通成员，验证权限差异
  insert into users (nick, pwd_hash, role, status)
  values ('_e2e_m_' || substr(md5(random()::text),1,6), 'x', 'member', 'active')
  returning id, nick into v_member, v_mnick;

  raise notice '⑦ 成员 % drive.use = %（应 f —— 默认只给 owner/admin）',
    v_mnick, acl_can('drive.use', null, v_member);
  raise notice '⑧ 成员 drive.use → acl_why = %（应 no）', acl_why('drive.use', null, v_member);
  raise notice '⑨ 成员 code.run = %（应 t —— 默认给 member）',
    acl_can('code.run', null, v_member);

  -- 闸门拒绝实测
  begin
    perform acl_require('drive.use', null, v_member);
    raise notice '⑩ 闸门没拦住（不该出现）';
  exception when others then
    raise notice '⑩ 闸门已拦住成员：%', SQLERRM;
  end;

  -- 普通成员查别人权限应被拒
  v_mtok := 'e2e_m_' || md5(random()::text);
  insert into sessions (token_hash, user_id, expires_at)
  values (v_mtok, v_member, now() + interval '1 hour');
  perform set_config('request.headers',
    json_build_object('x-session', v_mtok)::text, true);
  raise notice '⑪ 成员查站长权限 = %（应 f —— 不能枚举他人）',
    acl_can('drive.use', null, v_uid);
  raise notice '⑫ 成员查自己 = %（应 f，他本来就没有）', acl_can('drive.use', null, v_member);
end $$;
rollback;
