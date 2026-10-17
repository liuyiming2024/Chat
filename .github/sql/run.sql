/* 核实 C-3：无会话（匿名）调 state_get，会不会返回全站用户？ */
do $$
declare r json; n int; hasreal boolean;
begin
  raise notice '① 当前 gate_passed()（无任何会话）= %', gate_passed();
  raise notice '② 当前 cur_user() = %', cur_user();

  select state_get() into r;
  n := json_array_length(coalesce(r->'users','[]'::json));
  raise notice '③ ★匿名调 state_get 返回用户数 = %', n;
  raise notice '④ users 里含 realName 字段 = %', (r->'users'->0) ? 'realName';
  raise notice '⑤ users 里含 perms 字段 = %', (r->'users'->0) ? 'perms';
  raise notice '⑥ users 里含 bio 字段 = %', (r->'users'->0) ? 'bio';
  raise notice '⑦ users 里含 lastSeen 字段 = %', (r->'users'->0) ? 'lastSeen';
  raise notice '⑧ 首个用户 nick = % / role = %', r->'users'->0->>'nick', r->'users'->0->>'role';
  raise notice '⑨ me 字段 = %（null 表示未登录）', r->>'me';
end $$;
