\echo '=== 判定 ==='
select case
  when prosrc like '%coalesce(m.rev, 0) >= coalesce(p_since, 0)%' then 'OK: 按 rev 比大小'
  when prosrc like '%m.created_at > v_from%' then '旧版: 仍在用时间窗'
  else '未知'
end as state_delta_impl
from pg_proc where proname='state_delta';
\echo '=== rev 列与触发器 ==='
select count(*) filter (where column_name='rev') as has_rev_col
  from information_schema.columns where table_name='messages';
select count(*) as triggers from pg_trigger
 where tgrelid='messages'::regclass and not tgisinternal;
