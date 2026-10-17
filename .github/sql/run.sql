/* S-129 验证 ①：端口默认是否关闭（没有 token 时） */
begin;
do $$
declare v_tok text := 'atk_fake_' || md5(random()::text); r json;
begin
  raise notice '① api_tokens 现有行数 = %（应 0 —— 未预置）',
    (select count(*) from api_tokens);

  -- 假 token 应被拒
  begin
    select api_profile_list(v_tok) into r;
    raise notice '② 假 token 竟然通过了（不该出现！）';
  exception when others then
    raise notice '② 假 token 被拒：%', SQLERRM;
  end;

  -- 空 token
  begin
    select api_profile_list('') into r;
    raise notice '③ 空 token 竟然通过了（不该出现）';
  exception when others then
    raise notice '③ 空 token 被拒：%', SQLERRM;
  end;

  -- 未登录不能创建 token
  begin
    select api_token_create('test','read') into r;
    raise notice '④ 未登录竟然能创建 token（不该出现）';
  exception when others then
    raise notice '④ 未登录创建被拒：%', SQLERRM;
  end;
end $$;
rollback;
