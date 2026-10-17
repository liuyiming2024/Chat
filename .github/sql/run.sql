/* 复验：messages 是扁平数组（前端 convert 时才按房间分组） */
do $outer$
declare v_tok text; r json; n int;
begin
  select user_login('liuyiming2024','20120421lym') into r;
  v_tok := r->>'token';
  perform set_config('request.headers', json_build_object('x-session', v_tok)::text, true);
  select state_get() into r;
  raise notice '① 消息数 = %', json_array_length(coalesce(r->'messages','[]'::json));
  raise notice '② 已撤回(deleted) = % 条',
    (select count(*) from json_array_elements(r->'messages') x where (x->>'deleted')::boolean);
  raise notice '③ 已编辑(editedAt 非空) = % 条',
    (select count(*) from json_array_elements(r->'messages') x where x->>'editedAt' is not null);
  raise notice '④ 有回复(replyTo 非空) = % 条',
    (select count(*) from json_array_elements(r->'messages') x where x->>'replyTo' is not null);
  raise notice '⑤ 含 @ 的 = % 条',
    (select count(*) from json_array_elements(r->'messages') x where x->>'body' like '%@liuyiming2024%');
  raise notice '⑥ 最长一条字数 = %',
    (select max(length(x->>'body')) from json_array_elements(r->'messages') x);
  raise notice '⑦ 有 rev = % 条',
    (select count(*) from json_array_elements(r->'messages') x where x->>'rev' is not null);
  raise notice '⑧ 首条正文 = %',
    left((select x->>'body' from json_array_elements(r->'messages') x order by (x->>'rev')::bigint limit 1), 26);
end $outer$;
