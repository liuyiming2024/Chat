/* 线上实测 S-135：site_info / site_set / gate_enable / gate_disable / user_self_unban / acl_why */
do $outer$
declare r json; okb boolean; stt text;
begin
  select user_login('liuyiming2024','***REMOVED***') into r;
  perform set_config('request.headers', json_build_object('x-session', r->>'token')::text, true);

  select site_info() into r;
  raise notice '① site_info = %', r::text;

  select acl_why('drive.use') into stt;
  raise notice '② acl_why(自己) = %', stt;

  -- 改站点名 + 关注册，再改回来（必须还原，否则线上真的变样）
  select site_set('刘一鸣的项目', false) into okb;
  raise notice '③ site_set 改名+关注册 = %', okb;
  select site_info() into r;
  raise notice '④ 改后 allowRegister = %', (r->>'allowRegister');

  select site_set('刘一鸣的项目站', true) into okb;
  select site_info() into r;
  raise notice '⑤ ★已还原：name=% allowRegister=%',
    (r->>'siteName'), (r->>'allowRegister');

  -- 门禁：开启 → 关闭（必须还原到"关闭"，因为现在是关闭状态）
  select gate_enable('probePwd12345') into r;
  raise notice '⑥ gate_enable = %', r::text;
  select site_info() into r;
  raise notice '⑦ 开启后 hasGate=% gateOff=%', (r->>'hasGate'), (r->>'gateOff');

  select gate_disable() into r;
  select site_info() into r;
  raise notice '⑧ ★已还原：hasGate=% gateOff=%', (r->>'hasGate'), (r->>'gateOff');

  select user_self_unban() into okb;
  raise notice '⑨ user_self_unban（站长自助）= %', okb;
end $outer$;
