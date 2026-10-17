/* S-130 验证 ①：draft_add 是否真的无需密钥 */
begin;
do $$
declare r json; v_id uuid; i int;
begin
  raise notice '① 未登录（无会话）直接丢草稿：';
  for i in 1..3 loop
    select draft_add('测试草稿 ' || i, 'text', null, null, null, 'e2e') into r;
    raise notice '   第 % 条 ok=% createdAt=%', i, (r->>'ok'), (r->>'createdAt');
  end loop;

  -- 空内容应被拒
  begin
    select draft_add('') into r;
    raise notice '② 空内容竟然通过（不该出现）';
  exception when others then
    raise notice '② 空内容被拒：%', SQLERRM;
  end;

  -- 超长应被拒
  begin
    select draft_add(repeat('字', 9000)) into r;
    raise notice '③ 超长竟然通过（不该出现）';
  exception when others then
    raise notice '③ 超长被拒：%', SQLERRM;
  end;

  -- ★ 时间戳是否服务端写入（不接受客户端传的）
  raise notice '④ 时间戳由服务端写：三条各不相同 = %',
    (select count(distinct created_at) from drafts where source='e2e');

  -- 排序验证
  raise notice '⑤ 按时间正序第一条 = %',
    (select body from drafts where source='e2e' order by created_at asc limit 1);
end $$;
rollback;
