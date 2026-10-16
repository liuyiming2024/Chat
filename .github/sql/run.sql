begin;
set local request.headers = '{"x-session": "e2e-page-probe"}';
insert into sessions (token_hash, user_id, expires_at, gate_ok)
select encode(digest('e2e-page-probe','sha256'),'hex'), u.id, now() + interval '1 hour', true
from users u where u.status='active' limit 1;
do $$
declare d jsonb; g jsonb;
begin
  g := state_get()::jsonb;
  raise notice '① state_get 消息条数 = %', jsonb_array_length(coalesce(g->'messages','[]'::jsonb));
  raise notice '② state_get msgCursor = %  msgMore = %', g->'msgCursor', g->'msgMore';
  d := state_delta(0)::jsonb;
  raise notice '③ state_delta 消息条数 = %', jsonb_array_length(coalesce(d->'messages','[]'::jsonb));
  raise notice '④ state_delta msgCursor = %  msgMore = %', d->'msgCursor', d->'msgMore';
  raise notice '⑤ state_delta 顶层键 = %', (select string_agg(k,',') from jsonb_object_keys(d) k);
end $$;
rollback;
