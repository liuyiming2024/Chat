/* room_mute 要求对方在房间里 —— 先 member_add 再加禁言 */
do $outer$
declare r json; okb boolean; u1 uuid; u2 uuid; m uuid;
begin
  select id into u1 from users where nick='测试账号一';
  select id into u2 from users where nick='测试账号二';

  select user_login('liuyiming2024','***REMOVED***') into r;
  perform set_config('request.headers', json_build_object('x-session', r->>'token')::text, true);

  -- 把测试账号一加进公屏（他还没加入过，所以上一步 room_mute 报"不在此房间"）
  select member_add('public', u1) into okb;
  raise notice '① 把 测试账号一 加入公屏 = %', okb;

  select room_mute('public', u1, 10) into okb;
  raise notice '② 群内禁言 测试账号一 10 分钟 = %', okb;

  select user_login('测试账号一','test1234') into r;
  perform set_config('request.headers', json_build_object('x-session', r->>'token')::text, true);
  begin
    select msg_send('public','text','我该发不出去') into r;
    raise notice '③ 禁言后竟然发出去了（不该出现！）';
  exception when others then
    raise notice '③ ★禁言生效，被拒：%', SQLERRM;
  end;

  -- 私聊不受影响（dm 房间 id 需重算）
  declare dm text;
  begin
    select room_dm((select id from users where nick='liuyiming2024')) into dm;
    select msg_send(dm,'text','【验证】私聊不受公屏禁言影响') into r;
    raise notice '④ 私聊仍能发 = %', (r->>'id') is not null;
  exception when others then
    raise notice '④ 私聊也被拒：%', SQLERRM;
  end;
end $outer$;
