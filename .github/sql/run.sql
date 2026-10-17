/* 解除测试账号一的禁言，别把它留在"不能说话"的状态 */
do $outer$
declare r json; okb boolean; u1 uuid; u2 uuid;
begin
  select user_login('liuyiming2024','20120421lym') into r;
  perform set_config('request.headers', json_build_object('x-session', r->>'token')::text, true);
  select id into u1 from users where nick='测试账号一';
  select id into u2 from users where nick='测试账号二';
  select room_mute('public', u1, 0) into okb;
  raise notice '① 解除禁言 = %', okb;
  select member_admin('public', u2, false) into okb;
  raise notice '② 撤销 测试账号二 的群管理员 = %', okb;
  begin
    select user_login('测试账号一','test1234') into r;
    perform set_config('request.headers', json_build_object('x-session', r->>'token')::text, true);
    select msg_send('public','text','【验证】解禁后恢复发言。') into r;
    raise notice '③ 解禁后能发言 = %', (r->>'id') is not null;
  exception when others then raise notice '③ 仍不能发言：%', SQLERRM; end;
end $outer$;
