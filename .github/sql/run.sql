/* S-141 实测：换 source 能否绕过限流（事务内，跑完回滚） */
begin;
/* 灌 100 条：分成 4 个不同 source，每个 25 条（都低于单来源上限 30） */
insert into drafts (kind, body, source)
select 'text', 'bulk-'||g, 'src-'||(g%4) from generate_series(1,100) g;
select count(*) as 已灌入 from drafts where deleted_at is null
  and created_at > now() - interval '1 minute';
select count(*) as 单来源最多多少条 from (
  select coalesce(nullif(source,''),'anon') s, count(*) c from drafts
   where deleted_at is null and created_at > now() - interval '1 minute'
   group by 1 order by c desc limit 1) t;
rollback;
select count(*) as 回滚后草稿总数 from drafts where deleted_at is null;

/* 函数是否已带全局闸门 */
select (draft_limits()->>'perMinuteGlobal') as 全站每分钟上限;
select count(*) as draft_clear已建 from pg_proc where proname='draft_clear';
