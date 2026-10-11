-- ==================================================================
-- S-001：增量拉取改为按 rev 比大小
--
-- 原来：v_from := now() - (rev差 × 2秒 + 30)，where created_at > v_from
-- 问题：rev 差 × 2 秒只是估算。离线 1 小时、站点冷清时 rev 差很小、
--       时间窗就很窄 —— 离线期间的消息全落在窗外。
--       前端按 id merge，缺了就永远缺了。
-- 改法：messages 加 rev 列，直接比大小，可建索引。
-- ==================================================================

-- ---------- 1. 加列 ----------
alter table messages add column if not exists rev bigint;

-- ---------- 2. 回填存量 ----------
-- 按 created_at 顺序分配递增号，全部分在当前序列值之上，
-- 这样对已在线的客户端来说是"新的"，会被拉一次（前端按 id merge，无害）。
do $$
declare n int;
begin
  create temporary table _mf as
    select id, row_number() over (order by created_at, id) as rn
      from messages where rev is null;
  select count(*) from _mf into n;
  if n > 0 then
    update messages m set rev = nextval('state_rev') where m.rev is null;
  end if;
  drop table _mf;
end $$;

-- ---------- 3. 触发器：insert 与 update 都要 bump ----------
-- 只 bump insert 的话，编辑/撤回后的消息 rev 不变，
-- 客户端按 rev 增量拉取永远拿不到这次变更。
create or replace function msg_rev_bump() returns trigger
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
begin
  new.rev := nextval('state_rev');
  return new;
end $$;

drop trigger if exists messages_rev_bi on messages;
create trigger messages_rev_bi before insert on messages
  for each row execute function msg_rev_bump();

drop trigger if exists messages_rev_bu on messages;
create trigger messages_rev_bu before update on messages
  for each row execute function msg_rev_bump();

create index if not exists messages_rev_idx on messages (rev);

-- ---------- 4. 校验 ----------
select count(*) as total,
       count(rev) as has_rev,
       count(*) - count(rev) as missing
  from messages;
select '触发器数: ' || count(*) from pg_trigger
 where tgrelid = 'messages'::regclass and not tgisinternal;
