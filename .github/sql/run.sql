-- 用行为验证，不用文本匹配：
-- 文本匹配会把注释里的 "perform nextval" 也算上，误报。
\echo '=== S-006 行为验证：登录失败是否推进序号 ==='
do $$
declare a bigint; b bigint; r json;
begin
  select last_value into a from state_rev;
  -- 用一个不存在的昵称试错（不会真的建账号）
  select user_login('probe-nonexistent-xyz', 'bad-pw') into r;
  select last_value into b from state_rev;
  raise notice 'S-006: 失败前=% 失败后=% 差值=% （应为 0）', a, b, b - a;
  if b <> a then
    raise notice '✗ 登录失败仍推进了序号';
  else
    raise notice '✓ 登录失败不推进序号';
  end if;
end $$;

\echo '=== S-008 行为验证：连续换昵称爆破是否会被拦 ==='
do $$
declare i int; r json; hit boolean := false;
begin
  for i in 1..130 loop
    select user_login('probe-attacker-' || i, 'bad') into r;
    if (r->>'ok') = 'false' and (r->>'err') like '%过于频繁%' then
      hit := true; exit;
    end if;
  end loop;
  if hit then raise notice '✓ 换昵称爆破被全局闸门拦住';
  else raise notice '✗ 换昵称爆破没有被拦住'; end if;
end $$;

\echo '=== S-007 session_cleanup 会清 login_attempts ==='
do $$
declare n0 int; n1 int;
begin
  insert into login_attempts (nick, ok, created_at)
    values ('probe-old', false, now() - interval '48 hours');
  select count(*) into n0 from login_attempts
   where nick='probe-old' and created_at < now() - interval '24 hours';
  perform session_cleanup();
  select count(*) into n1 from login_attempts where nick='probe-old';
  raise notice 'S-007: 清理前=% 清理后=% （应为 1 → 0）', n0, n1;
  delete from login_attempts where nick like 'probe-%';
end $$;
