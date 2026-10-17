/* 核实 C-3（修正 ? 操作符：-> 返回 json，? 只有 jsonb 才有，需 ::jsonb） */
do $$
declare r json; u json;
begin
  select state_get() into r;
  u := r->'users'->0;
  raise notice '① 用户数 = %', json_array_length(coalesce(r->'users','[]'::json));
  raise notice '② ★realName 是否下发 = %', (u::jsonb) ? 'realName';
  raise notice '③ ★perms 是否下发 = %', (u::jsonb) ? 'perms';
  raise notice '④ ★bio 是否下发 = %', (u::jsonb) ? 'bio';
  raise notice '⑤ ★lastSeen 是否下发 = %', (u::jsonb) ? 'lastSeen';
  raise notice '⑥ nick = % / role = % / status = %',
    u->>'nick', u->>'role', u->>'status';
  raise notice '⑦ me = %（null = 未登录，却拿到了全部）', coalesce(r->>'me','NULL');

  -- state_delta 同样问题？
  declare r2 json;
  begin
    select state_delta(0) into r2;
    raise notice '⑧ state_delta 匿名返回用户数 = %',
      json_array_length(coalesce(r2->'users','[]'::json));
  end;
end $$;
