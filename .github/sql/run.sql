/* 用两个测试账号补上：私聊 / @他人 / 群管理 / 群禁言 */
do $outer$
declare r json; okb boolean; u1 uuid; u2 uuid; dm text; m uuid;
begin
  select id into u1 from users where nick='测试账号一';
  select id into u2 from users where nick='测试账号二';

  -- 私聊：站长 → 测试账号一
  select user_login('liuyiming2024','***REMOVED***') into r;
  perform set_config('request.headers', json_build_object('x-session', r->>'token')::text, true);
  select room_dm(u1) into dm;
  raise notice '① 私聊房间 id = %', dm;
  select msg_send(dm,'text','【验证】这是一条私聊消息。') into r;
  raise notice '② 私聊消息已发 = %', (r->>'id') is not null;

  -- @他人：在公屏 @测试账号一
  select msg_send('public','text','@测试账号一 这是一条 @ 他人的验证') into r;
  m := (r->>'id')::uuid;
  raise notice '③ 公屏 @他人 已发 = %', (r->>'id') is not null;

  -- 群管理：把测试账号二设为公屏管理员
  select member_admin('public', u2, true) into okb;
  raise notice '④ 设 测试账号二 为群管理员 = %', okb;

  -- 群禁言：禁 测试账号一 10 分钟
  select room_mute('public', u1, 10) into okb;
  raise notice '⑤ 群内禁言 测试账号一 = %', okb;

  -- ★ 验证禁言真的生效：切到测试账号一，应发不出
  select user_login('测试账号一','test1234') into r;
  perform set_config('request.headers', json_build_object('x-session', r->>'token')::text, true);
  begin
    select msg_send('public','text','我该发不出去') into r;
    raise notice '⑥ 禁言后竟然发出去了（不该出现！）';
  exception when others then
    raise notice '⑥ ★禁言生效，被拒：%', SQLERRM;
  end;

  -- 私聊里能发（禁言只限该群）
  begin
    select msg_send(dm,'text','【验证】私聊不受公屏禁言影响') into r;
    raise notice '⑦ 私聊仍能发 = %', (r->>'id') is not null;
  exception when others then
    raise notice '⑦ 私聊也被拒：%', SQLERRM;
  end;
end $outer$;
