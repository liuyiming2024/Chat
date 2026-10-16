begin;
set local request.headers = '{"x-session": "e2e-page600"}';
insert into sessions (token_hash, user_id, expires_at, gate_ok)
select encode(digest('e2e-page600','sha256'),'hex'), u.id, now() + interval '1 hour', true
from users u where u.status='active' limit 1;
do $$
declare d jsonb; uid uuid; i int;
begin
  select id into uid from users where status='active' limit 1;

  -- ⚠ 造 600 条消息来验证分页是否真的生效。
  --   线上真实消息是 0 条，不造数据就测不出 limit 有没有起作用。
  --   整个事务 rollback，不留痕。
  for i in 1..600 loop
    insert into messages (room_id, from_id, type, body)
    values ('public', uid, 'text', 'probe-' || i);
  end loop;

  d := state_delta(0)::jsonb;
  raise notice '① 总消息 600，本批返回 = %（应 <=500）',
    jsonb_array_length(coalesce(d->'messages','[]'::jsonb));
  raise notice '② msgMore = %（应为 true）', d->'msgMore';
  raise notice '③ msgCursor = %（应 > 0）', d->'msgCursor';

  -- 用游标继续拉第二批
  d := state_delta((d->>'msgCursor')::bigint)::jsonb;
  raise notice '④ 第二批返回 = %（应为剩下的 100）',
    jsonb_array_length(coalesce(d->'messages','[]'::jsonb));
  raise notice '⑤ 第二批 msgMore = %（应为 false）', d->'msgMore';

  -- state_get 取最新的 500
  d := state_get()::jsonb;
  raise notice '⑥ state_get 返回 = %（应 =500）',
    jsonb_array_length(coalesce(d->'messages','[]'::jsonb));
  raise notice '⑦ state_get 首条 = %（应是 probe-101 附近，即"最新的500条"里最旧的）',
    (d->'messages'->0)->'text';
end $$;
rollback;
