/* S-130 验证 ②（重跑）：排序稳定性 + 整理端链路 */
begin;
do $$
declare
  v_oid uuid; v_otok text; v_w json; v_wtok text;
  r json; i int; ids uuid[] := '{}';
begin
  for i in 1..5 loop
    select draft_add('草稿' || i, 'text', null, null, null, 'e2e') into r;
    ids := ids || (r->>'id')::uuid;
  end loop;

  raise notice '① 5 条时间戳各不相同 = %（应 5）',
    (select count(distinct created_at) from drafts where source='e2e');
  raise notice '② 正序第一条 = %（应 草稿1）',
    (select body from drafts where source='e2e' order by created_at, sort_seq limit 1);
  raise notice '③ 倒序第一条 = %（应 草稿5）',
    (select body from drafts where source='e2e' order by created_at desc, sort_seq desc limit 1);

  select id into v_oid from users where role='owner' limit 1;
  v_otok := 'e2e_o_' || md5(random()::text);
  insert into sessions (token_hash, user_id, expires_at)
  values (encode(digest(v_otok,'sha256'),'hex'), v_oid, now() + interval '1 hour');
  perform set_config('request.headers', json_build_object('x-session', v_otok)::text, true);
  select api_token_create('e2e-w','write') into v_w;
  v_wtok := v_w->>'token';

  begin
    select draft_list('') into r;
    raise notice '④ 空 token 竟然能取（不该出现）';
  exception when others then
    raise notice '④ 空 token 取草稿被拒：%', SQLERRM;
  end;

  select draft_list(v_wtok) into r;
  raise notice '⑤ 有 token 取到条数 = %', json_array_length(r->'drafts');

  select draft_prompt(v_wtok) into r;
  raise notice '⑥ 提示词长度 = % 字，开头 = %',
    length(r->>'prompt'), left(r->>'prompt', 20);

  select draft_del_many(v_wtok, ids) into r;
  raise notice '⑦ 批量删除 = % 条（应 5）', (r->>'deleted');
  raise notice '⑧ 逻辑删除后物理行数仍 = %（不物理删）',
    (select count(*) from drafts where source='e2e');
  raise notice '⑨ draft_list 默认不再返回 = % 条',
    json_array_length((select draft_list(v_wtok)::json->'drafts'));

  begin
    select draft_del(v_wtok, ids[1]) into r;
    raise notice '⑩ 重复删竟成功（不该出现）';
  exception when others then
    raise notice '⑩ 重复删被拒：%', SQLERRM;
  end;
end $$;
rollback;
