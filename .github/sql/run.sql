/* S-141 真验证：换一个全新 source，还能不能绕过限流？（事务内，跑完回滚） */
begin;
/* 灌 100 条，分散成 4 个 source（每个 25 条，都低于单来源上限 30） */
insert into drafts (kind, body, source)
select 'text', 'bulk-'||g, 'src-'||(g%4) from generate_series(1,100) g;

/* 每个来源各多少条 */
select coalesce(nullif(source,''),'anon') as 来源, count(*) as 条数 from drafts
 where deleted_at is null and created_at > now() - interval '1 minute'
 group by 1 order by 条数 desc;

/* 关键：用一个**全新的** source 调用 draft_add。
   单来源闸门对它是 0 条，必然放行 ——
   如果它仍被拒，说明全局闸门生效了。 */
do $$
begin
  begin
    perform draft_add('绕过尝试-全新来源', 'text', null, null, null, 'brand-new-src-xyz');
    raise notice '❌ 没被挡住 —— 换 source 仍能绕过，限流无效';
  exception when others then
    raise notice '✅ 被挡住：%', SQLERRM;
  end;
end $$;
rollback;

/* 回滚后应为空 */
select count(*) as 回滚后草稿总数 from drafts where deleted_at is null;
