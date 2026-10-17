/* S-133：造测试账号，补上 5 项需要"第二个人"的功能验证 */
do $outer$
declare r json; okb boolean; v_allow boolean;
begin
  raise notice '① allow_register = %', (select allow_register from site where id=true);
end $outer$;

-- 若未开放注册，先临时打开（注册的账号待审核，正好验证审核队列）
update site set allow_register = true where id = true and not allow_register;

do $outer$
declare r json;
begin
  select user_register('测试账号一','test1234','用于验证私聊与@他人') into r;
  raise notice '② 注册 测试账号一 = %', r->>'ok';
  select user_register('测试账号二','test1234','用于验证群管理') into r;
  raise notice '③ 注册 测试账号二 = %', r->>'ok';
  select user_register('待审核账号','test1234','留在队列里验证审核功能') into r;
  raise notice '④ 注册 待审核账号 = %', r->>'ok';
  raise notice '⑤ 现在 pending 数 = %', (select count(*) from users where status='pending');
end $outer$;
