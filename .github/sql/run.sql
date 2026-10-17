/* 按提出人要求：密码改为全部小写（手机端输入不用切大小写） */
begin;
do $$
declare n int;
begin
  update users set pwd_hash = crypt('rnnqlb87jxx7rsp2qgo7', gen_salt('bf', 10))
   where role = 'owner';
  get diagnostics n = row_count;
  raise notice '① 已重置站长密码（全小写），影响行数 = %', n;

  delete from sessions;
  raise notice '② 已清空全部会话';
end $$;

do $$
declare r json;
begin
  select user_login('站长','2PwfO299ILDjyjnGwlXx') into r;
  raise notice '③ 上一个含大写的密码 = %（应 false）', (r->>'ok');
end $$;
commit;
