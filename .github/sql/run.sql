/* 确认刚发的验证消息能被前端接口取回 */
do $outer$
declare v_tok text; r json; n int;
begin
  select user_login('liuyiming2024','20120421lym') into r;
  v_tok := r->>'token';
  perform set_config('request.headers', json_build_object('x-session', v_tok)::text, true);

  select state_get() into r;
  n := json_array_length(coalesce(r->'messages','[]'::json));
  raise notice '① state_get 取回消息数 = %', n;
  raise notice '② 消息按房间分组，public 房间条数 = %',
    json_array_length(coalesce((r->'messages'->'public'),'[]'::json));
  raise notice '③ 含已撤回标记的有 = % 条',
    (select count(*) from json_array_elements(r->'messages'->'public') x
      where (x->>'deleted')::boolean);
  raise notice '④ 含 editedAt 的有 = % 条',
    (select count(*) from json_array_elements(r->'messages'->'public') x
      where x->>'editedAt' is not null);
  raise notice '⑤ 首条正文前 30 字 = %',
    left((select x->>'body' from json_array_elements(r->'messages'->'public') x limit 1), 30);
end $outer$;
