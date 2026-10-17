-- ==================================================================
-- 人物档案与日记 · 独立数据库结构
--   项目：liuyiming2024/Archive（独立仓库，与 Chat/Code/Tool 无代码关联）
--
-- ⚠ 独立性约定（用户 2026-10-12 明确要求）：
--   · 只复用"统一账号体系"：cur_user() / acl_require() 等身份与权限设施
--     由账号服务提供，本项目不自建账号表。
--   · **数据完全独立**：下面这些表只有本项目读写，
--     其他项目不引用、不 JOIN、不依赖。
--   · 本项目也不引用其他项目的任何表。
--   · 仓库是公开的，所以**仓库里绝不放数据**，数据只在数据库里，
--     网页运行时才去取。
--
-- 三层架构（用户 2026-10-12 定稿）：
--   原始随手记 →（改写，最大程度尊重原文）→ 第1层 大日记
--              →（提炼 + 分门别类，归到每个人）→ 第2层 小日记
--              →（总体概括）→ 第3层 个人档案（含相册）
-- ==================================================================

create table if not exists profiles (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  note       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists profiles_time_idx on profiles (updated_at desc);

-- 原始随手记 + 第 1 层（改写后即大日记的一行）
create table if not exists profile_entries (
  id         uuid primary key default gen_random_uuid(),
  -- profile_id 可空：有的随手记不属于任何具体的人，只进大日记
  profile_id uuid references profiles(id) on delete cascade,
  -- body = 原始随手记，**永不被改写覆盖**
  body       text not null default '',
  -- polished = 改写后的正文。只润色流畅度，最大程度尊重原文：
  --   理顺句子、修正错别字、口语转书面；
  --   **不许加推断、不许加评价、不许润色出原文没有的信息**
  polished   text,
  images     text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists profile_entries_idx on profile_entries (profile_id, created_at desc);
create index if not exists profile_entries_time_idx on profile_entries (created_at desc);

-- 第 2 层 · 小日记：归到每个人的、分门别类的条日记
--   "今天见到了谁，第二天又和他干了啥"
create table if not exists profile_notes (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid references profiles(id) on delete cascade,
  category    text not null default '',
  content     text not null,
  source_ids  uuid[] not null default '{}',  -- 来自哪些原始条目，要能回溯
  happened_at timestamptz,                   -- 事发时间；记不清就不填，不假装知道
  created_at  timestamptz not null default now()
);
create index if not exists profile_notes_idx
  on profile_notes (profile_id, happened_at desc nulls last, created_at desc);

-- 第 3 层 · 个人档案 / 大日记的整理结果
--   profile_id 为空 = 整体大日记；有值 = 某个人
--   kind: timeline 时间线 | category 分类条目 | digest 结构化摘要
--         outline 大纲概览 | detail 详细数据
create table if not exists profile_summaries (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete cascade,
  kind       text not null,
  content    text not null,
  created_at timestamptz not null default now()
);
create index if not exists profile_summaries_idx on profile_summaries (profile_id, created_at desc);

-- 图片：单独一套，不复用其他项目的媒体表
create table if not exists profile_media (
  id         uuid primary key default gen_random_uuid(),
  uploader   uuid,
  name       text not null default '',
  size       bigint not null default 0,
  path       text not null unique,
  committed  boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists profile_media_path_idx on profile_media(path);

-- 权限点登记：档案归站长
insert into acl_perm_label (key, value) values ('site.profile', '查看人物档案')

/* ================================================================
   Q-Chat-S-127：权限点已并入全站统一 ACL
   ================================================================
   本库与聊天室连的是**同一个 Supabase**（pimryrsxkwyafmponegp.supabase.co），
   共用 users / sessions / acl_can / acl_require。
   所以这里不用自建账号体系，也不用自建权限表 ——
   每个函数开头的 `perform acl_require('site.profile');` 就是闸门本体：
   被拒绝直接抛异常、事务回滚，一个字都不会返回。

   ⚠ 权限点注册在全站的 `site_perms` 表里（project = 'archive'）。
     改名必须两边同步：这里 acl_require 用的 key，
     必须在 site_perms 里有同名行，否则 admin 永远拿不到 ——
     而 owner 靠 acl_can 里的"站长恒为全部"直接放行，
     于是问题只在 admin 身上出现，站长自己测不出来。
=============================================================== */
  on conflict (key) do nothing;
/* ⚠ 这里原来有一段 `update acl_role_perms set perms = ... where role='owner'`
   —— 那是**死代码**，已删除（ARCHIVE-ACL-DEADCODE）。

   实测（2026-10-15，只读体检确认）：
     · 线上**没有** acl_role_perms 这个**表**，只有同名**函数** acl_role_perms(text)
     · 原来那句用 `if exists (... tables where table_name='acl_role_perms')` 包着，
       表不存在 → 整段静默跳过，**不报错**
     · 结果：迁移看着"成功"，授权却根本没发生

   那 owner 到底怎么拿到 site.profile 的？
   看 acl_can() 的实现里有这一句：
       if u.role = 'owner' then return true; end if;
   **owner 在权限判定里被直接放行**，不依赖任何权限点清单。
   所以 site.profile 不登记进数组也没关系 —— 这才是真实机制。

   给后来人的提醒：
     · 不要照着"角色权限表"的想象去写 SQL，先查线上真实结构
     · 用 if exists 包住的操作，失败时是**静默**的；
       这在生产上比直接报错危险得多 —— 报错你还会去查，静默你以为成功了
     · 需要给 admin（非 owner）开放档案权限时，
       正确做法是往该用户的 users.perms 里加 'site.profile'，
       不是改什么角色表 */
insert into acl_perm_label (key, value) values ('site.profile', '查看人物档案')
  on conflict (key) do nothing;

-- ==================================================================
-- 函数。**每一个都先 acl_require** ——
-- 用户已决定不加密（加密则整理时拿不到明文），
-- 所以鉴权是唯一那道闸门，漏一个就全漏了。
-- ==================================================================

create or replace function profile_list()
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  return coalesce((
    select json_agg(x) from (
      select p.id, p.name, p.note, p.updated_at,
        (select count(*) from profile_entries e where e.profile_id = p.id) as entry_count,
        (select count(*) from profile_notes n where n.profile_id = p.id) as note_count
      from profiles p order by p.updated_at desc
    ) x
  ), '[]'::json);
end;
$$;

create or replace function profile_create(p_name text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare v_id uuid;
begin
  perform acl_require('site.profile');
  if coalesce(trim(p_name), '') = '' then raise exception '请填人物名'; end if;
  insert into profiles (name) values (trim(p_name)) returning id into v_id;
  perform nextval('state_rev');
  return json_build_object('id', v_id);
end;
$$;

-- 随手记：原文入库。profile_id 可为空（不归属任何人）
create or replace function profile_entry_add(p_profile uuid, p_body text, p_images text[] default '{}')
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare v_id uuid;
begin
  perform acl_require('site.profile');
  if p_profile is not null
     and not exists (select 1 from profiles where id = p_profile) then
    raise exception '人物不存在';
  end if;
  if coalesce(trim(p_body), '') = '' and coalesce(array_length(p_images, 1), 0) = 0 then
    raise exception '写点什么，或至少加张图';
  end if;
  insert into profile_entries (profile_id, body, images)
  values (p_profile, coalesce(p_body, ''), coalesce(p_images, '{}'))
  returning id into v_id;
  if p_profile is not null then
    update profiles set updated_at = now() where id = p_profile;
  end if;
  perform nextval('state_rev');
  return json_build_object('id', v_id);
end;
$$;

-- 改写：只写 polished 列，**绝不动 body**
create or replace function profile_entry_polish(p_id uuid, p_polished text)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  update profile_entries set polished = p_polished where id = p_id;
  perform nextval('state_rev');
  return true;
end;
$$;

create or replace function profile_entry_del(p_id uuid)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  delete from profile_entries where id = p_id;
  perform nextval('state_rev');
  return true;
end;
$$;

-- 第 1 层 · 大日记：所有条目按时间汇集，不分人
create or replace function journal_list(p_limit int default 200, p_offset int default 0)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  return coalesce((
    select json_agg(x) from (
      select e.id, e.body, e.polished, e.images, e.created_at, e.profile_id,
             p.name as profile_name
      from profile_entries e
      left join profiles p on p.id = e.profile_id
      order by e.created_at desc
      limit greatest(coalesce(p_limit, 200), 1)
      offset greatest(coalesce(p_offset, 0), 0)
    ) x
  ), '[]'::json);
end;
$$;

create or replace function journal_count()
returns bigint language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  return (select count(*) from profile_entries);
end;
$$;

-- 第 2 层 · 小日记
create or replace function profile_notes_get(p_profile uuid)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  return coalesce((
    select json_agg(x) from (
      -- 按事发时间排，不是录入时间：补记的内容要落在正确位置
      select id, category, content, source_ids, happened_at, created_at
      from profile_notes
      where profile_id is not distinct from p_profile
      order by happened_at desc nulls last, created_at desc
    ) x
  ), '[]'::json);
end;
$$;

create or replace function profile_note_add(p_profile uuid, p_category text, p_content text,
                                            p_source_ids uuid[] default '{}',
                                            p_happened_at timestamptz default null)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare v_id uuid;
begin
  perform acl_require('site.profile');
  if coalesce(trim(p_content), '') = '' then raise exception '内容为空'; end if;
  if p_profile is not null
     and not exists (select 1 from profiles where id = p_profile) then
    raise exception '人物不存在';
  end if;
  insert into profile_notes (profile_id, category, content, source_ids, happened_at)
  values (p_profile, coalesce(trim(p_category), ''), p_content,
          coalesce(p_source_ids, '{}'), p_happened_at)
  returning id into v_id;
  if p_profile is not null then
    update profiles set updated_at = now() where id = p_profile;
  end if;
  perform nextval('state_rev');
  return json_build_object('id', v_id);
end;
$$;

create or replace function profile_note_del(p_id uuid)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  delete from profile_notes where id = p_id;
  perform nextval('state_rev');
  return true;
end;
$$;

-- 第 3 层 · 整理结果：永远新增一版，不覆盖
create or replace function profile_summary_add(p_profile uuid, p_kind text, p_content text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare v_id uuid;
begin
  perform acl_require('site.profile');
  if p_kind not in ('timeline', 'category', 'digest', 'outline', 'detail') then
    raise exception '整理形态必须是 timeline / category / digest / outline / detail';
  end if;
  if coalesce(trim(p_content), '') = '' then raise exception '整理内容为空'; end if;
  insert into profile_summaries (profile_id, kind, content)
  values (p_profile, p_kind, p_content)
  returning id into v_id;
  perform nextval('state_rev');
  return json_build_object('id', v_id);
end;
$$;

create or replace function profile_summaries_get(p_profile uuid)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  return coalesce((
    select json_agg(s) from (
      select distinct on (kind) id, kind, content, created_at
      from profile_summaries where profile_id is not distinct from p_profile
      order by kind, created_at desc
    ) s
  ), '[]'::json);
end;
$$;

create or replace function profile_summary_history(p_profile uuid, p_kind text)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  return coalesce((
    select json_agg(x) from (
      select id, content, created_at from profile_summaries
      where profile_id is not distinct from p_profile and kind = p_kind
      order by created_at desc
    ) x
  ), '[]'::json);
end;
$$;

-- 相册：这个人名下所有条目里的图片
create or replace function profile_album(p_profile uuid)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  return coalesce((
    select json_agg(x) from (
      select distinct on (img) img as path,
        (select min(created_at) from profile_entries e2
          where e2.profile_id = p_profile and img = any(e2.images)) as taken_at
      from (select unnest(e.images) as img
            from profile_entries e where e.profile_id = p_profile) t
      order by img
    ) x
  ), '[]'::json);
end;
$$;

-- 图片槽位（单独一套）
create or replace function profile_media_prepare(p_name text, p_size bigint)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare v_id uuid; v_path text;
begin
  perform acl_require('site.profile');
  if coalesce(p_size, 0) > 20 * 1024 * 1024 then raise exception '单张不能超过 20MB'; end if;
  v_path := 'profiles/' || cur_user()::text || '/' || replace(gen_random_uuid()::text, '-', '') || '_' || coalesce(p_name, 'f');
  insert into profile_media (uploader, name, size, path)
  values (cur_user(), coalesce(p_name, ''), coalesce(p_size, 0), v_path)
  returning id into v_id;
  return json_build_object('id', v_id, 'path', v_path);
end;
$$;

create or replace function profile_media_allowed(p_path text)
returns boolean language sql stable security definer
set search_path = public, extensions, pg_temp as $$
  -- 必须校验主人，否则拿到 path 就能覆盖别人的图
  select exists (
    select 1 from profile_media
    where path = p_path and uploader = cur_user()
      and committed = false and created_at > now() - interval '15 minutes'
  );
$$;

create or replace function profile_media_commit(p_path text)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  update profile_media set committed = true
  where path = p_path and uploader = cur_user();
  return true;
end;
$$;

grant execute on function profile_list() to anon, authenticated;
grant execute on function profile_create(text) to anon, authenticated;
grant execute on function profile_entry_add(uuid, text, text[]) to anon, authenticated;
grant execute on function profile_entry_polish(uuid, text) to anon, authenticated;
grant execute on function profile_entry_del(uuid) to anon, authenticated;
grant execute on function journal_list(int, int) to anon, authenticated;
grant execute on function journal_count() to anon, authenticated;
grant execute on function profile_notes_get(uuid) to anon, authenticated;
grant execute on function profile_note_add(uuid, text, text, uuid[], timestamptz) to anon, authenticated;
grant execute on function profile_note_del(uuid) to anon, authenticated;
grant execute on function profile_summary_add(uuid, text, text) to anon, authenticated;
grant execute on function profile_summaries_get(uuid) to anon, authenticated;
grant execute on function profile_summary_history(uuid, text) to anon, authenticated;
grant execute on function profile_album(uuid) to anon, authenticated;
grant execute on function profile_media_prepare(text, bigint) to anon, authenticated;
grant execute on function profile_media_allowed(text) to anon, authenticated;
grant execute on function profile_media_commit(text) to anon, authenticated;


/* ==================================================================
   API 端口（Q-Chat-S-129）—— 给外部 AI 整理档案数据用
   ==================================================================

   设计要点：

   ★ **不预置任何 token**。
     api_tokens 表建好时是空的 —— 端口处于**关闭**状态，
     任何调用都会被拒。站长（owner）用 `api_token_create` 生成
     第一个 token 之后，端口才真正可用。
     ⚠ 这样"没配好"的表现是"明确拒绝"，而不是"意外放行"。

   ★ token 存**哈希**不存明文。
     数据库被读到也还原不出 token。明文只在生成的那一刻
     返回一次，之后无法再取回（只能吊销重建）。

   ★ scope 分 read / write。
     只读的整理任务就给 read —— 写权限能改数据，
     不该因为"反正都是我自己的 AI"就一律给全权。

   ★ **铁律继承**：原文永不被覆盖。
     所以**没有**任何 API 能改 `profile_entries.body`。
     只有 `api_entry_polish` 写 `polished` 列。
     给 AI 的端口也不能破这条规矩 ——
     否则"用 AI 整理"反而成了最容易丢失原文的途径。

   ★ 每个 token 记 last_used_at，可审计：
     发现某个 token 在异常时间被用过，能定位到是哪一个。

================================================================== */

create table if not exists api_tokens (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,                    -- 给谁用，自己看得懂就行
  token_hash   text not null unique,             -- sha256(明文)
  scope        text not null default 'read',     -- 'read' | 'write'
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,                      -- 空 = 长期有效
  revoked_at   timestamptz,                      -- 非空 = 已吊销
  last_used_at timestamptz
);

/* ⚠ 不建 RLS：api_tokens 是**凭据表**，闸门在 api_check() 里。
   建 RLS 反而可能让"创建新 token"被策略挡住而报不出原因。 */

/* ----------------------------------------------------------------
   api_check —— 内部校验。所有 api_* 函数第一行都调它。
   ----------------------------------------------------------------
   ⚠ 返回 void + 不合法就 raise exception，
     而不是返回 boolean 让调用方自己判断 ——
     **返回 boolean 的话，漏写一个 if 就是全站放行**。
     抛异常是"忘了处理就必然失败"，这是更安全的默认。 */
create or replace function api_check(p_token text, p_need_write boolean default false)
returns uuid
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare t record;
begin
  if p_token is null or p_token = '' then
    raise exception '缺少 token';
  end if;

  select * into t from api_tokens k
  where k.token_hash = encode(digest(p_token, 'sha256'), 'hex');

  if not found then
    /* ⚠ 刻意不区分"token 不存在"和"token 错了" ——
       区分了就等于告诉对方"这个前缀是对的，继续试"。 */
    raise exception 'token 无效';
  end if;

  if t.revoked_at is not null then
    raise exception 'token 已吊销';
  end if;

  if t.expires_at is not null and t.expires_at < now() then
    raise exception 'token 已过期';
  end if;

  if p_need_write and t.scope <> 'write' then
    raise exception '这个 token 只有读权限，不能修改数据';
  end if;

  return t.id;
end;
$$;

/* 记录使用时间（放在 stable 函数里不能改，所以单独一个 volatile 的） */
create or replace function api_touch(p_token text) returns void
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
begin
  update api_tokens
     set last_used_at = now()
   where token_hash = encode(digest(p_token, 'sha256'), 'hex');
end;
$$;

/* ================================================================
   token 管理（仅站长）
================================================================ */
create or replace function api_token_create(
  p_name text,
  p_scope text default 'read',
  p_days int default null          -- 多少天后过期；null = 长期
) returns json
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare v_plain text; v_id uuid;
begin
  perform acl_require('site.profile');          -- 只有站长/有档案权限者
  if p_scope not in ('read','write') then
    raise exception 'scope 只能是 read 或 write';
  end if;

  v_plain := 'atk_' || encode(gen_random_bytes(24), 'hex');
  insert into api_tokens (name, token_hash, scope, expires_at)
  values (p_name, encode(digest(v_plain,'sha256'),'hex'), p_scope,
          case when p_days is null then null else now() + (p_days || ' days')::interval end)
  returning id into v_id;

  /* ⚠ 明文**只在这一次返回**。之后库里只有哈希，谁也取不回来 ——
     包括站长自己。忘了就只能吊销重建，这是刻意的。 */
  return json_build_object('ok', true, 'id', v_id, 'token', v_plain,
                           'scope', p_scope, 'name', p_name);
end;
$$;

create or replace function api_token_list() returns json
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  return json_build_object('ok', true, 'tokens', coalesce((
    select json_agg(json_build_object(
      'id', k.id, 'name', k.name, 'scope', k.scope,
      'createdAt', k.created_at, 'expiresAt', k.expires_at,
      'revokedAt', k.revoked_at, 'lastUsedAt', k.last_used_at
    )) from api_tokens k order by k.created_at desc
  ), '[]'::json));
end;
$$;

create or replace function api_token_revoke(p_id uuid) returns json
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  update api_tokens set revoked_at = now() where id = p_id and revoked_at is null;
  if not found then raise exception 'token 不存在或已吊销'; end if;
  return json_build_object('ok', true);
end;
$$;

/* ================================================================
   读
================================================================ */

/* 人员清单 —— AI 整理前先拿这个，才知道有哪些人 */
create or replace function api_profile_list(p_token text) returns json
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform api_check(p_token);
  perform api_touch(p_token);
  /* ⚠ 这里踩过坑：`select json_agg(...) from profiles p order by ...`
     会报 "column must appear in the GROUP BY clause" ——
     json_agg 是聚合函数，order by 直接跟在 FROM 后会被当成窗口排序。
     正确写法是把排序放进**子查询**（现有 profile_list 就是这么写的，
     我第一版参考了它却没照抄结构）。 */
  return json_build_object('ok', true, 'profiles', coalesce((
    select json_agg(json_build_object(
      'id', x.id, 'name', x.name, 'note', x.note,
      'updatedAt', x.updated_at,
      'entryCount', (select count(*) from profile_entries e where e.profile_id = x.id),
      'noteCount',  (select count(*) from profile_notes n where n.profile_id = x.id)
    )) from (
      select p.id, p.name, p.note, p.updated_at
        from profiles p order by p.updated_at desc
    ) x
  ), '[]'::json));
end;
$$;

/* 大日记（随手记）。p_profile 可空 = 只要未归属的 */
create or replace function api_entry_list(
  p_token text, p_profile uuid default null, p_limit int default 100, p_offset int default 0
) returns json
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform api_check(p_token);
  perform api_touch(p_token);
  if p_limit > 500 then p_limit := 500; end if;   -- 上限，防一次拖垮
  return json_build_object('ok', true, 'entries', coalesce((
    select json_agg(json_build_object(
      'id', e.id, 'profileId', e.profile_id, 'body', e.body,
      'polished', e.polished, 'images', e.images, 'createdAt', e.created_at
    )) from (
      select * from profile_entries e
      where (p_profile is null or e.profile_id = p_profile)
      order by e.created_at desc limit p_limit offset p_offset
    ) e
  ), '[]'::json));
end;
$$;

/* 某人的小日记（已归类） */
create or replace function api_note_list(p_token text, p_profile uuid) returns json
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform api_check(p_token);
  perform api_touch(p_token);
  return json_build_object('ok', true, 'notes', coalesce((
    select json_agg(json_build_object(
      'id', x.id, 'category', x.category, 'content', x.content,
      'sourceIds', x.source_ids, 'happenedAt', x.happened_at, 'createdAt', x.created_at
    )) from (
      select n.id, n.category, n.content, n.source_ids, n.happened_at, n.created_at
        from profile_notes n where n.profile_id = p_profile order by n.created_at desc
    ) x
  ), '[]'::json));
end;
$$;

/* 某人的档案（第三层） */
create or replace function api_summary_list(p_token text, p_profile uuid) returns json
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform api_check(p_token);
  perform api_touch(p_token);
  return json_build_object('ok', true, 'summaries', coalesce((
    select json_agg(json_build_object(
      'id', x.id, 'kind', x.kind, 'content', x.content, 'createdAt', x.created_at
    )) from (
      select s.id, s.kind, s.content, s.created_at
        from profile_summaries s where s.profile_id = p_profile order by s.created_at desc
    ) x
  ), '[]'::json));
end;
$$;

/* ================================================================
   写（需要 scope='write'）
================================================================ */

create or replace function api_profile_create(p_token text, p_name text, p_note text default '')
returns json
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare v_id uuid;
begin
  perform api_check(p_token, true);
  perform api_touch(p_token);
  insert into profiles (name, note) values (p_name, p_note) returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end;
$$;

/* 加随手记。★ 这是"原文"入口 —— 只能新增，没有对应的改/删 API */
create or replace function api_entry_add(
  p_token text, p_body text, p_profile uuid default null, p_images text[] default '{}'
) returns json
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare v_id uuid;
begin
  perform api_check(p_token, true);
  perform api_touch(p_token);
  insert into profile_entries (profile_id, body, images)
  values (p_profile, p_body, coalesce(p_images,'{}')) returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end;
$$;

/* 改写。★ 只写 polished —— body 是原文，任何 API 都不许碰。
   AI 整理的主要动作就是这一个：读 body → 整理 → 写 polished。 */
create or replace function api_entry_polish(p_token text, p_id uuid, p_polished text)
returns json
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform api_check(p_token, true);
  perform api_touch(p_token);
  update profile_entries set polished = p_polished where id = p_id;
  if not found then raise exception '条目不存在：%', p_id; end if;
  return json_build_object('ok', true);
end;
$$;

/* 加小日记（已归类）。sourceIds 要能回溯到原始条目。 */
create or replace function api_note_add(
  p_token text, p_profile uuid, p_category text, p_content text,
  p_source_ids uuid[] default '{}', p_happened_at timestamptz default null
) returns json
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare v_id uuid;
begin
  perform api_check(p_token, true);
  perform api_touch(p_token);
  insert into profile_notes (profile_id, category, content, source_ids, happened_at)
  values (p_profile, p_category, p_content, coalesce(p_source_ids,'{}'), p_happened_at)
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end;
$$;

/* 加档案总结。★ 只新增，不覆盖 —— 整理错了能退回上一版 */
create or replace function api_summary_add(
  p_token text, p_profile uuid, p_kind text, p_content text
) returns json
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare v_id uuid;
begin
  perform api_check(p_token, true);
  perform api_touch(p_token);
  insert into profile_summaries (profile_id, kind, content)
  values (p_profile, p_kind, p_content) returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end;
$$;

grant execute on function api_check(text, boolean) to anon, authenticated;
grant execute on function api_touch(text) to anon, authenticated;
grant execute on function api_token_create(text, text, int) to anon, authenticated;
grant execute on function api_token_list() to anon, authenticated;
grant execute on function api_token_revoke(uuid) to anon, authenticated;
grant execute on function api_profile_list(text) to anon, authenticated;
grant execute on function api_entry_list(text, uuid, int, int) to anon, authenticated;
grant execute on function api_note_list(text, uuid) to anon, authenticated;
grant execute on function api_summary_list(text, uuid) to anon, authenticated;
grant execute on function api_profile_create(text, text, text) to anon, authenticated;
grant execute on function api_entry_add(text, text, uuid, text[]) to anon, authenticated;
grant execute on function api_entry_polish(text, uuid, text) to anon, authenticated;
grant execute on function api_note_add(text, uuid, text, text, uuid[], timestamptz) to anon, authenticated;
grant execute on function api_summary_add(text, uuid, text, text) to anon, authenticated;


/* ==================================================================
   草稿箱 / 收件箱（Q-Chat-S-130）
   ==================================================================

   提出人的原话：
     "一个端口用于发送消息和文件到草稿箱中，发送时服务端自动带上时间戳，
      草稿箱内按照时间戳排序，整理端可以删除草稿箱里的东西，
      草稿箱里的东西就是我们下一次整理端口需要整理的。
      然后你那个 API 自带上一段提示词吧。
      至于这个普通端口，就不用密钥了，顶多给我当垃圾箱。"

   据此的设计：

   ★ **这个端口不要密钥**（提出人明确要求）。
     理由：它是"丢进来"的入口，不是"取出去"的入口。
     取数据、改数据仍然走上一节的 api_*（要 token）。
     所以**没有密钥 ≠ 档案可被读取** —— 往里丢和往外拿是两回事。

   ⚠ 但"不用密钥"意味着**任何人都能往里写**。
     所以必须做三件事，否则它会被灌爆：
       · 单条长度上限（正文 8000 字、文件名 200）
       · 总量上限（超过 N 条拒绝，提示先整理）
       · 频率限制（同一来源短时间内限次）

   ★ **服务端自动打时间戳**，不接受客户端传的时间。
     理由：客户端时间可以随便改。让他传，排序就失去意义 ——
     "按时间排序的收件箱"里出现一条声称来自 1998 年的东西，
     会直接破坏整理顺序。所以 happened_at 由 now() 写死。

   ★ **只能删，不能改**。
     草稿箱是"待整理队列"，改一条草稿等于伪造原始输入。
     整理错了应该改的是整理结果（polished / notes），
     不是改掉当初收到的那句话。

   ★ 删除是**逻辑删除**（deleted_at），不物理删。
     承总规划"删除 = 逻辑删除，给自己留退路"。

   ★ 自带提示词：`draft_prompt()` 返回给整理端 AI 的指令。
     ⚠ 提示词存在服务端而不是写死在调用方 ——
     这样改提示词不用改所有客户端，
     而整理端每次开工前拉一次，拿到的永远是最新的。

================================================================== */

create table if not exists drafts (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null default 'text',   -- 'text' | 'file'
  body       text not null default '',       -- 文字内容，或文件的说明
  file_name  text,                           -- kind='file' 时的文件名
  file_path  text,                           -- 文件已入库时的路径
  file_size  bigint,
  source     text not null default '',       -- 谁/哪个端丢进来的，自己填
  /* ⚠ 用 clock_timestamp() 而不是 now() ——
     实测踩坑：同一事务里连插 3 条，**三条时间戳完全相同**。
     因为 now() 返回的是**事务开始时刻**，整个事务内固定不变。

     后果：一次批量丢 3 条草稿，排序后谁先谁后是**不确定的**。
     而"按时间排序的收件箱"正是这个端口的全部意义 ——
     顺序不确定，整理端每次开工拿到的顺序都可能不一样，
     已经整理过的和没整理过的会混在一起。

     clock_timestamp() 返回**真实当前时刻**，逐条不同。
     再加 sort_seq 兜底（见下），双保险。 */
  created_at timestamptz not null default clock_timestamp(),
  sort_seq   bigserial not null,     -- ★ 同时间戳时的稳定次序
  deleted_at timestamptz             -- 逻辑删除
);

/* ⚠⚠ 又是同一个坑（本仓库第 3 次）：
   `create table if not exists` **不会更新已存在的表**。
   线上 drafts 表是上一版建的（没有 sort_seq、created_at 默认 now()），
   所以只写 create 的话：
     · sort_seq 列不存在 → 查询报 column does not exist
     · clock_timestamp() 默认没生效 → 实测 5 条时间戳仍然**全部相同**

   改已存在的表必须用 alter。这是"建新表"和"改老表"的区别，
   我上一轮在 site_perms 加 scope 列时已经踩过一模一样的。 */
alter table drafts add column if not exists sort_seq bigserial not null;
alter table drafts alter column created_at set default clock_timestamp();

create index if not exists drafts_pending_idx on drafts (created_at)
  where deleted_at is null;

/* ----------------------------------------------------------------
   常量：上限
----------------------------------------------------------------
   ⚠ 无密钥入口必须限量。不限量的话，任何人写个循环就能把表灌满，
     而整理端每次都要先拉全表 —— 结果就是整理端被拖垮，
     真正的档案数据反而没人整理了。 */
create or replace function draft_limits() returns json
language sql immutable as $$
  select json_build_object(
    'maxBody',   8000,    -- 单条正文上限（字符）
    'maxName',   200,     -- 文件名上限
    'maxPending', 2000,   -- 未整理条目上限，超了拒绝新增
    'perMinute',   30     -- 同一来源每分钟上限
  );
$$;

/* ----------------------------------------------------------------
   draft_add —— ★ 无需密钥。往草稿箱丢东西。
---------------------------------------------------------------- */
create or replace function draft_add(
  p_body      text,
  p_kind      text default 'text',
  p_file_name text default null,
  p_file_path text default null,
  p_file_size bigint default null,
  p_source    text default ''
) returns json
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_id uuid; lim json; n int; recent int;
begin
  lim := draft_limits();

  if p_body is null or p_body = '' then
    raise exception '内容是空的，没什么可存';
  end if;

  if length(p_body) > (lim->>'maxBody')::int then
    raise exception '单条内容太长（上限 % 字，这条 % 字），请拆分后再发',
      (lim->>'maxBody')::int, length(p_body);
  end if;

  if p_file_name is not null and length(p_file_name) > (lim->>'maxName')::int then
    raise exception '文件名太长（上限 % 字）', (lim->>'maxName')::int;
  end if;

  /* 总量闸门：先整理再继续丢，不然队列无限增长 */
  select count(*) into n from drafts where deleted_at is null;
  if n >= (lim->>'maxPending')::int then
    raise exception '草稿箱已满（% 条未整理），请先整理或清理再添加',
      (lim->>'maxPending')::int;
  end if;

  /* 频率闸门：按 p_source 计。空 source 归为同一组（'anon'）。
     ⚠ 不做这个的话，无密钥入口等于可以被无限调用。 */
  select count(*) into recent from drafts
   where deleted_at is null
     and created_at > now() - interval '1 minute'
     and coalesce(nullif(source,''),'anon') = coalesce(nullif(p_source,''),'anon');
  if recent >= (lim->>'perMinute')::int then
    raise exception '这个来源发得太快了（每分钟上限 % 条），稍后再试',
      (lim->>'perMinute')::int;
  end if;

  insert into drafts (kind, body, file_name, file_path, file_size, source)
  values (coalesce(p_kind,'text'), p_body, p_file_name, p_file_path, p_file_size, p_source)
  returning id into v_id;

  /* ⚠ 返回服务端时间 —— 调用方要用它来确认"我这条排在哪"，
     而客户端自己的钟可能是错的。 */
  return json_build_object('ok', true, 'id', v_id,
    'createdAt', (select created_at from drafts where id = v_id));
end;
$$;

/* ----------------------------------------------------------------
   draft_list —— ★ 需要 token。整理端取待办。
   ⚠ 按**服务端时间戳**排序（提出人要求）。
---------------------------------------------------------------- */
create or replace function draft_list(
  p_token text, p_limit int default 200, p_include_done boolean default false
) returns json
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform api_check(p_token);
  perform api_touch(p_token);
  if p_limit > 500 then p_limit := 500; end if;
  return json_build_object('ok', true, 'drafts', coalesce((
    select json_agg(json_build_object(
      'id', x.id, 'kind', x.kind, 'body', x.body,
      'fileName', x.file_name, 'filePath', x.file_path, 'fileSize', x.file_size,
      'source', x.source, 'createdAt', x.created_at, 'sortSeq', x.sort_seq
    )) from (
      select d.id, d.kind, d.body, d.file_name, d.file_path, d.file_size,
             d.source, d.created_at, d.sort_seq
        from drafts d
       where (p_include_done or d.deleted_at is null)
       /* ★ 时间正序：先来的先整理。
          ⚠ 必须带 sort_seq 兜底：时间戳精确到微秒，理论上仍可能撞，
          撞了顺序就不确定。加上自增序号，次序才是**唯一确定**的 ——
          同一批整理端每次拉到的顺序完全一致，
          否则"删掉已整理的"和"还没整理的"会混在一起。 */
       order by d.created_at asc, d.sort_seq asc
       limit p_limit
    ) x
  ), '[]'::json));
end;
$$;

/* ----------------------------------------------------------------
   draft_del —— ★ 需要 token。整理端清理。逻辑删除。
---------------------------------------------------------------- */
create or replace function draft_del(p_token text, p_id uuid) returns json
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform api_check(p_token, true);       -- 删除算写操作
  perform api_touch(p_token);
  update drafts set deleted_at = now()
   where id = p_id and deleted_at is null;
  if not found then
    raise exception '这条不存在或已经删过了';
  end if;
  return json_build_object('ok', true);
end;
$$;

/* 批量删：整理完一批，一次清掉，省得一条条调 */
create or replace function draft_del_many(p_token text, p_ids uuid[]) returns json
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare n int;
begin
  perform api_check(p_token, true);
  perform api_touch(p_token);
  with d as (
    update drafts set deleted_at = now()
     where id = any(coalesce(p_ids,'{}')) and deleted_at is null
    returning 1
  ) select count(*) into n from d;
  return json_build_object('ok', true, 'deleted', n);
end;
$$;

/* ----------------------------------------------------------------
   draft_prompt —— ★ 自带提示词
----------------------------------------------------------------
   ⚠ 提示词放在**服务端**而不是写死在调用方：
     · 改提示词不用改所有客户端
     · 整理端每次开工前拉一次，拿到的永远是最新的
   ⚠ 需要 token —— 提示词里含内部规则，
     不该让任何能访问到这个库的人读到。 */
create or replace function draft_prompt(p_token text) returns json
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform api_check(p_token);
  perform api_touch(p_token);
  return json_build_object('ok', true, 'prompt',
'你是一个档案整理助手。下面是"草稿箱"里的待整理内容，按时间正序排列（先来的在前）。

## 你的工作

对每一条草稿：
1. 判断它属于哪个人（profiles 里有名单）。判断不出就归为"未归属"，**不要猜**。
2. 用 api_entry_add 把原始内容存入大日记（原文原样，不要润色）。
3. 用 api_entry_polish 写入整理后的版本 —— 只润色流畅度：
   理顺句子、修正错别字、口语转书面。
   **不许加推断、不许加评价、不许润色出原文没有的信息。**
4. 如果内容里有可以归类的事实（生日、经历、偏好……），
   用 api_note_add 存成小日记，**source_ids 指回原条目**，要能回溯。
   事发时间记不清就留空，**不要猜一个填进去**。
5. 整理完用 draft_del 或 draft_del_many 把这条从草稿箱删掉。

## 三条硬规矩

- **原文永不被覆盖。** 任何接口都不能改 profile_entries.body，
  你只能写 polished 列。整理结果永远新增，不覆盖旧的。
- **记不清就不填。** 档案里一个错的时间/地点，比"未知"更有害。
- **不许编造。** 原文没说的，一个字都不许加。

## 顺序

按 createdAt 从早到晚处理。处理完一条删一条。');
end;
$$;

grant execute on function draft_limits() to anon, authenticated;
grant execute on function draft_add(text, text, text, text, bigint, text) to anon, authenticated;
grant execute on function draft_list(text, int, boolean) to anon, authenticated;
grant execute on function draft_del(text, uuid) to anon, authenticated;
grant execute on function draft_del_many(text, uuid[]) to anon, authenticated;
grant execute on function draft_prompt(text) to anon, authenticated;
