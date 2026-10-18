/* 反向验证：99 条（低于阈值 100）时应放行 —— 排除"闸门写成了永远拒绝" */
begin;
insert into drafts (kind, body, source)
select 'text', 'bulk-'||g, 'src-'||(g%4) from generate_series(1,99) g;
do $$
begin
  begin
    perform draft_add('阈值下应放行', 'text', null, null, null, 'brand-new-src-2');
    raise notice '✅ 99 条时放行 —— 阈值判断准确，不是永远拒绝';
  exception when others then
    raise notice '❌ 99 条也被挡：% —— 闸门过严或写错', SQLERRM;
  end;
end $$;
rollback;

/* draft_clear 无 token 必须拒绝 */
do $$
begin
  begin
    perform draft_clear('fake-token-not-exist', 'CLEAR-ALL');
    raise notice '❌ 假 token 竟能清空草稿箱 —— 严重漏洞';
  exception when others then
    raise notice '✅ draft_clear 拒了假 token：%', SQLERRM;
  end;
end $$;
select count(*) as 草稿总数_应为0 from drafts where deleted_at is null;
