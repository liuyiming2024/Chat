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
