/* 线上实测 S-134 修复所依赖的服务端函数确实可用（前端之前没接，不是服务端没有） */
do $outer$
declare r json; u1 uuid; dm text; okb boolean;
begin
  select user_login('liuyiming2024','***REMOVED***') into r;
  perform set_config('request.headers', json_build_object('x-session', r->>'token')::text, true);
  select id into u1 from users where nick='测试账号一';

  select room_dm(u1) into dm;
  raise notice '① room_dm 可用，返回 = %', dm;
  raise notice '② 该房间已进 rooms 表 = %', (select count(*) from rooms where id = dm);
  raise notice '③ 成员已进 room_members = %',
    (select count(*) from room_members where room_id = dm);

  select msg_send(dm,'text','【验证】私聊在这个房间里能发出去。') into r;
  raise notice '④ ★私聊发消息 = %（有 id 即成功）', (r->>'id') is not null;

  -- 退出群聊：先加回公屏再退，看 room_members 是否真的被删
  select member_add('public', u1) into okb;
  raise notice '⑤ 加回公屏 = %', okb;
  perform set_config('request.headers', json_build_object('x-session',
    (select user_login('测试账号一','test1234')->>'token'))::text, true);
  select room_leave('public') into okb;
  raise notice '⑥ ★room_leave 返回 = %', okb;
  raise notice '⑦ ★退出后 room_members 里还有他吗 = %（应 0）',
    (select count(*) from room_members where room_id='public' and user_id=u1);
end $outer$;
