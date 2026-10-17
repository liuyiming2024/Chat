/* 用真实字段名复验（text / edited / replyTo / deleted） */
do $outer$
declare v_tok text; r json;
begin
  select user_login('liuyiming2024','20120421lym') into r;
  perform set_config('request.headers',
    json_build_object('x-session', r->>'token')::text, true);
  select state_get() into r;
  raise notice '① 消息数 = %', json_array_length(coalesce(r->'messages','[]'::json));
  raise notice '② 已撤回 = %', (select count(*) from json_array_elements(r->'messages') x where (x->>'deleted')::boolean);
  raise notice '③ 已编辑 = %', (select count(*) from json_array_elements(r->'messages') x where x->>'edited' is not null);
  raise notice '④ 有回复 = %', (select count(*) from json_array_elements(r->'messages') x where x->>'replyTo' is not null);
  raise notice '⑤ 含 @ = %', (select count(*) from json_array_elements(r->'messages') x where x->>'text' like '%@liuyiming2024%');
  raise notice '⑥ 最长 = % 字', (select max(length(x->>'text')) from json_array_elements(r->'messages') x);
  raise notice '⑦ 公式 $$ 块级 = % 条', (select count(*) from json_array_elements(r->'messages') x where x->>'text' like '%$%$%');
  raise notice '⑧ 代码块 = % 条', (select count(*) from json_array_elements(r->'messages') x where x->>'text' like '%```%');
  raise notice '⑨ 表格 = % 条', (select count(*) from json_array_elements(r->'messages') x where x->>'text' like '%|---|---|%');
  raise notice '⑩ 首条 = %', left((select x->>'text' from json_array_elements(r->'messages') x limit 1), 24);
end $outer$;
