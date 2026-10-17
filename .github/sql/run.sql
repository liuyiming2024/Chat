/* 查 state_delta 报的 u.avatar 到底存不存在（可能是迁移漏了列 → 同步整条坏掉） */
do $$
begin
  raise notice '① users 表有 avatar 列吗 = %',
    (select count(*) from information_schema.columns
      where table_name='users' and column_name='avatar');
  raise notice '② users 现有列 = %',
    (select string_agg(column_name, ', ' order by ordinal_position)
      from information_schema.columns where table_name='users');
end $$;
