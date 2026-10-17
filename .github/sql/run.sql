/* S-129 验证 ②：token 读写完整链路 */
begin;
do $$
declare
  v_oid uuid; v_otok text;
  v_read json; v_readtok text; v_write json; v_writetok text;
  r json; v_pid uuid; v_eid uuid; v_nid uuid;
begin
  select id into v_oid from users where role='owner' limit 1;
  v_otok := 'e2e_o_' || md5(random()::text);
  insert into sessions (token_hash, user_id, expires_at)
  values (encode(digest(v_otok,'sha256'),'hex'), v_oid, now() + interval '1 hour');
  perform set_config('request.headers', json_build_object('x-session', v_otok)::text, true);

  select api_token_create('e2e-read','read') into v_read;
  v_readtok := v_read->>'token';
  select api_token_create('e2e-write','write') into v_write;
  v_writetok := v_write->>'token';
  raise notice '① read token 前 8 位 = %', left(v_readtok, 8);

  select api_profile_list(v_readtok) into r;
  raise notice '② read 读人员清单 ok = %', (r->>'ok');

  begin
    select api_profile_create(v_readtok,'_e2e_','') into r;
    raise notice '③ read 竟然能写（不该出现）';
  exception when others then
    raise notice '③ read token 写被拒：%', SQLERRM;
  end;

  select api_profile_create(v_writetok,'_e2e_person_','') into r;
  v_pid := (r->>'id')::uuid;
  select api_entry_add(v_writetok,'今天他提到小时候养过一只猫。', v_pid) into r;
  v_eid := (r->>'id')::uuid;
  raise notice '④ 建人 + 加随手记 = %', (r->>'ok');

  select api_entry_polish(v_writetok, v_eid, '他回忆起童年曾养过一只猫。') into r;
  raise notice '⑤ 改写 polished = %', (r->>'ok');

  select api_note_add(v_writetok, v_pid, '童年', '养过一只猫', array[v_eid]) into r;
  v_nid := (r->>'id')::uuid;
  raise notice '⑥ 加小日记 = %', (r->>'ok');

  select api_summary_add(v_writetok, v_pid, 'overview', '童年有养猫经历。') into r;
  raise notice '⑦ 加档案总结 = %', (r->>'ok');

  raise notice '⑧ ★原文 body = %', (select body from profile_entries where id = v_eid);
  raise notice '⑨ polished = %', (select polished from profile_entries where id = v_eid);
  raise notice '⑩ 小日记可回溯 sourceIds = %', (select source_ids from profile_notes where id = v_nid);

  select api_note_list(v_readtok, v_pid) into r;
  raise notice '⑪ read 读小日记条数 = %', json_array_length(r->'notes');

  select api_token_revoke((v_read->>'id')::uuid) into r;
  begin
    select api_profile_list(v_readtok) into r;
    raise notice '⑫ 吊销后仍能使用（不该出现）';
  exception when others then
    raise notice '⑫ 吊销后失效：%', SQLERRM;
  end;
end $$;
rollback;
