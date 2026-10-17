/* S-129 验证 ②：owner 生成 token 后的读写链路 */
begin;
do $$
declare
  v_oid uuid; v_otok text;
  v_read json; v_readtok text; v_write json; v_writetok text;
  r json; v_pid uuid; v_eid uuid; v_nid uuid; v_sid uuid;
begin
  select id into v_oid from users where role='owner' limit 1;
  v_otok := 'e2e_o_' || md5(random()::text);
  insert into sessions (token_hash, user_id, expires_at)
  values (encode(digest(v_otok,'sha256'),'hex'), v_oid, now() + interval '1 hour');
  perform set_config('request.headers', json_build_object('x-session', v_otok)::text, true);

  -- 生成 read / write 两个 token
  select api_token_create('e2e-read','read') into v_read;
  v_readtok := v_read->>'token';
  select api_token_create('e2e-write','write') into v_write;
  v_writetok := v_write->>'token';
  raise notice '① read token 前缀 = %', left(v_readtok, 8);
  raise notice '② write token 生成 = %', (v_write->>'ok');

  -- ★ 明文不可再取回：库里只有哈希
  raise notice '③ 库里存的是哈希（不含明文 %）= %',
    v_readtok, (select count(*) from api_tokens where token_hash = v_readtok);

  -- read token 能读
  select api_profile_list(v_readtok) into r;
  raise notice '④ read 读人员清单 ok = %', (r->>'ok');

  -- ★ read token 不能写
  begin
    select api_profile_create(v_readtok,'_e2e_','') into r;
    raise notice '⑤ read token 竟然能写（不该出现！）';
  exception when others then
    raise notice '⑤ read token 写被拒：%', SQLERRM;
  end;

  -- write token 走完整整理链路
  select api_profile_create(v_writetok,'_e2e_person_','') into r;
  v_pid := (r->>'id')::uuid;
  raise notice '⑥ 建人 = %', (r->>'ok');

  select api_entry_add(v_writetok,'今天他提到小时候养过一只猫。', v_pid) into r;
  v_eid := (r->>'id')::uuid;
  raise notice '⑦ 加随手记 = %', (r->>'ok');

  -- ★ 核心动作：读原文 → 整理 → 写 polished（不碰 body）
  select api_entry_polish(v_writetok, v_eid, '他回忆起童年曾养过一只猫。') into r;
  raise notice '⑧ 改写 polished = %', (r->>'ok');

  select api_note_add(v_writetok, v_pid, '童年', '养过一只猫', array[v_eid]) into r;
  v_nid := (r->>'id')::uuid;
  raise notice '⑨ 加小日记 = %', (r->>'ok');

  select api_summary_add(v_writetok, v_pid, 'overview', '童年有养猫经历。') into r;
  v_sid := (r->>'id')::uuid;
  raise notice '⑩ 加档案总结 = %', (r->>'ok');

  -- ★ 铁律复核：原文还在，且 polished 是整理后的
  raise notice '⑪ 原文 body = %',
    (select body from profile_entries where id = v_eid);
  raise notice '⑫ polished = %',
    (select polished from profile_entries where id = v_eid);
  raise notice '⑬ 小日记能回溯 sourceIds = %',
    (select source_ids from profile_notes where id = v_nid);

  -- 吊销后失效
  select api_token_revoke((v_read->>'id')::uuid) into r;
  begin
    select api_profile_list(v_readtok) into r;
    raise notice '⑭ 吊销后竟然还能用（不该出现）';
  exception when others then
    raise notice '⑭ 吊销后失效：%', SQLERRM;
  end;
end $$;
rollback;
