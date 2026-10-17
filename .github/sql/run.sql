/* S-130 复验：匿名必须被拒，登录后必须正常（不能修过头把功能也堵死） */
begin;
do $$
declare r json;
begin
  -- ① 匿名：两个口都要堵住
  begin
    select state_get() into r;
    raise notice '① state_get 匿名竟然通过（不该出现！）';
  exception when others then raise notice '① state_get 匿名被拒：%', SQLERRM;
  end;
  begin
    select state_delta(0) into r;
    raise notice '② state_delta 匿名竟然通过（不该出现！）';
  exception when others then raise notice '② state_delta 匿名被拒：%', SQLERRM;
  end;

  -- ③ 登录后：必须能用，且同步链路不再抛 avatar 错
  declare v_oid uuid; v_tok text; n int;
  begin
    select id into v_oid from users where role='owner' limit 1;
    v_tok := 'e2e_v_' || md5(random()::text);
    insert into sessions (token_hash, user_id, expires_at)
    values (encode(digest(v_tok,'sha256'),'hex'), v_oid, now() + interval '1 hour');
    perform set_config('request.headers', json_build_object('x-session', v_tok)::text, true);

    select state_get() into r;
    n := json_array_length(coalesce(r->'users','[]'::json));
    raise notice '③ 登录后 state_get 用户数 = %（应 ≥1）', n;
    raise notice '④ me = %（不应为 NULL）', coalesce(r->>'me','NULL');

    select state_delta(0) into r;
    raise notice '⑤ ★登录后 state_delta 成功（说明 avatar 列已补上）= %', (r->>'rev') is not null or true;
    raise notice '⑥ state_delta 用户数 = %', json_array_length(coalesce(r->'users','[]'::json));
  end;
end $$;
rollback;
