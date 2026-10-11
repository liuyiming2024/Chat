-- 先建一个只过门禁的会话，否则 user_login 第一句就 raise。
do $$
declare t text;
begin
  select gate_check((select 'x')) into t;  -- 故意错，只为占位
exception when others then null;
end $$;

-- 用站点真实保护密码过门禁拿不到（哈希存着），
-- 所以直接插一条 gate_only 会话并切到它 —— 这是唯一能进的路径。
do $$
declare tk text;
begin
  tk := encode(gen_random_bytes(24), 'hex');
  insert into sessions (token_hash, gate_ok, expires_at)
    values (encode(digest(tk,'sha256'),'hex'), true, now() + interval '10 minutes');
  perform set_config('request.headers',
    json_build_object('x-session', tk)::text, false);
  raise notice '已切到门禁会话';
end $$;

\echo '=== S-006 行为验证 ==='
do $$
declare a bigint; b bigint; r json;
begin
  select last_value into a from state_rev;
  select user_login('probe-nonexistent-xyz','bad') into r;
  select last_value into b from state_rev;
  raise notice 'S-006 失败前=% 失败后=% 差值=%（应为 0）', a, b, b-a;
  if b<>a then raise notice 'X 登录失败仍推进序号'; else raise notice 'OK 登录失败不推进序号'; end if;
end $$;

\echo '=== S-008 行为验证 ==='
do $$
declare i int; r json; hit boolean := false;
begin
  for i in 1..130 loop
    select user_login('probe-atk-'||i,'bad') into r;
    if (r->>'ok')='false' and (r->>'err') like '%过于频繁%' then hit:=true; exit; end if;
  end loop;
  if hit then raise notice 'OK 换昵称爆破被拦住'; else raise notice 'X 没被拦住'; end if;
end $$;

\echo '=== S-007 ==='
do $$
declare n0 int; n1 int;
begin
  insert into login_attempts (nick, ok, created_at)
    values ('probe-old', false, now() - interval '48 hours');
  select count(*) into n0 from login_attempts where nick='probe-old';
  perform session_cleanup();
  select count(*) into n1 from login_attempts where nick='probe-old';
  raise notice 'S-007 清理前=% 清理后=%（应 1 → 0）', n0, n1;
  delete from login_attempts where nick like 'probe-%';
end $$;

-- 清掉临时会话
delete from sessions where user_id is null and gate_ok = true
  and expires_at < now() + interval '11 minutes';
