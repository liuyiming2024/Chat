/* S-131 验证：无门会话限流 + session_cleanup 权限 + 正常登录不受影响 */
begin;
do $$
declare i int; n int; blocked boolean := false; r json;
begin
  -- ① 连签 15 次（阈值 200 内，应都成功）
  for i in 1..15 loop
    select gate_check('x') into r;
  end loop;
  select count(*) into n from sessions where user_id is null
   and created_at > now() - interval '5 minutes';
  raise notice '① 签了 15 次后，5 分钟内匿名会话数 = %', n;

  -- ② 人为灌到阈值：直接插到 200 条以上（模拟攻击）
  insert into sessions (token_hash, user_id, expires_at)
  select encode(digest('flood_'||g||md5(random()::text),'sha256'),'hex'),
         null, now() + interval '1 hour'
  from generate_series(1, 200) g;

  begin
    select gate_check('x') into r;
    raise notice '② 超阈值后竟然还签发（不该出现）';
  exception when others then
    raise notice '② ★超阈值被拒：%', SQLERRM;
  end;

  -- ③ session_cleanup 对 anon 的权限已收回
  raise notice '③ anon 对 session_cleanup 的 execute 权限 = %（应 0/f）',
    (select count(*) from information_schema.role_routine_grants
      where grantee='anon' and routine_name='session_cleanup'
        and privilege_type='EXECUTE');

  -- ④ 正常登录仍然能用（限流不能误伤）
  declare v_oid uuid; v_tok text;
  begin
    select id into v_oid from users where role='owner' limit 1;
    v_tok := 'e2e_ok_' || md5(random()::text);
    insert into sessions (token_hash, user_id, expires_at)
    values (encode(digest(v_tok,'sha256'),'hex'), v_oid, now() + interval '1 hour');
    perform set_config('request.headers', json_build_object('x-session', v_tok)::text, true);
    select state_get() into r;
    raise notice '④ 登录后 state_get 仍正常，用户数 = %',
      json_array_length(coalesce(r->'users','[]'::json));
  end;
end $$;
rollback;
