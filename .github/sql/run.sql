-- 人物档案建表（幂等，可重复跑）
-- 来源：chat/supabase/schema.sql 档案段落
-- 执行方式：Actions → 数据库执行 → mode=可写

create table if not exists profiles (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  note       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists profiles_time_idx on profiles (updated_at desc);

/* 零散条目。body 是随手记的文字；images 是媒体路径数组。
   ⚠ images 用 text[] 而不是关联表：条目与图片是一对多的弱关联，
   单独建表会让"删条目"变成级联删除多张图，
   而图片本体在 storage，删了表记录还会留孤儿文件。 */
create table if not exists profile_entries (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  body       text not null default '',
  images     text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists profile_entries_idx on profile_entries (profile_id, created_at desc);

/* 整理结果。每次整理留一版 —— 用户明确要求"相当于历史记录"。
   ⚠ 不能覆盖：整理错了还能退回上一版。
   覆盖式保存是最难挽回的那类事故 —— 错了就找不回来了。 */
create table if not exists profile_summaries (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  kind       text not null,          /* timeline | category | digest */
  content    text not null,
  entry_from timestamptz,            /* 这次整理覆盖的条目起点 */
  entry_to   timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists profile_summaries_idx on profile_summaries (profile_id, created_at desc);

/* 档案图片：单独一套，不复用 media_objects。
   为什么单独：media_objects 强绑定 room_id（消息媒体），
   档案图片不属于任何房间，硬塞进去要填假的 room_id，
   将来清理旧媒体时会误伤档案图片。
   代价是上传函数要写两份 —— 但语义清晰比省几行重要。 */
create table if not exists profile_media (
  id         uuid primary key default gen_random_uuid(),
  uploader   uuid references users(id) on delete cascade,
  name       text not null default '',
  size       bigint not null default 0,
  path       text not null unique,
  committed  boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists profile_media_path_idx on profile_media(path);

/* 权限点登记：档案归站长 */
insert into acl_perm_label (key, value) values ('site.profile', '查看人物档案')
  on conflict (key) do nothing;
/* 站长默认权限里加上这一条 */
do $$
begin
  if exists (select 1 from information_schema.tables where table_name='acl_role_perms') then
    update acl_role_perms set perms = array_append(perms, 'site.profile')
    where role='owner' and not ('site.profile' = any(perms));
  end if;
end $$;

/* ---------- 档案读写 ---------- */

create or replace function profile_list()
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  /* ⚠ 必须先 acl_require 再返回数据（用户明确要求"显示前先鉴权"）。
     不能把数据发给前端再由前端决定显不显示 ——
     那样内容已经到了客户端，隐藏只是障眼法。 */
  perform acl_require('site.profile');
  return coalesce((
    select json_agg(x) from (
      select p.id, p.name, p.note, p.updated_at,
        (select count(*) from profile_entries e where e.profile_id = p.id) as entry_count,
        (select count(*) from profile_summaries sm where sm.profile_id = p.id) as summary_count
      from profiles p order by p.updated_at desc
    ) x
  ), '[]'::json);
end;
$$;

create or replace function profile_create(p_name text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; v_id uuid;
begin
  perform acl_require('site.profile');
  uid := cur_user();
  if coalesce(trim(p_name), '') = '' then raise exception '请填人物名'; end if;
  insert into profiles (name) values (trim(p_name)) returning id into v_id;
  perform nextval('state_rev');
  return json_build_object('id', v_id);
end;
$$;

create or replace function profile_get(p_id uuid)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  perform acl_require('site.profile');
  return (
    select json_build_object(
      'profile', row_to_json(p),
      'entries', coalesce((
        select json_agg(e order by e.created_at desc) from (
          select id, body, images, created_at from profile_entries
          where profile_id = p.id
        ) e
      ), '[]'::json),
      /* 三种整理形态各取最新一版 —— 前端默认展示最新的，
         历史版本另外查，不混在详情里（否则越用越慢） */
      'summaries', coalesce((
        select json_agg(s) from (
          select distinct on (kind) id, kind, content, created_at
          from profile_summaries where profile_id = p.id
          order by kind, created_at desc
        ) s
      ), '[]'::json)
    )
    from profiles p where p.id = p_id
  );
end;
$$;

create or replace function profile_entry_add(p_profile uuid, p_body text, p_images text[] default '{}')
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare v_id uuid;
begin
  perform acl_require('site.profile');
  if not exists (select 1 from profiles where id = p_profile) then
    raise exception '档案不存在';
  end if;
  /* 空条目不入库：随手一点误触会攒出一堆空记录，
     而空条目会被整理进来，污染结果。 */
  if coalesce(trim(p_body), '') = '' and coalesce(array_length(p_images, 1), 0) = 0 then
    raise exception '写点什么，或至少加张图';
  end if;
  insert into profile_entries (profile_id, body, images)
  values (p_profile, coalesce(p_body, ''), coalesce(p_images, '{}'))
  returning id into v_id;
  update profiles set updated_at = now() where id = p_profile;
  perform nextval('state_rev');
  return json_build_object('id', v_id);
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

/* 保存整理结果。**永远新增一版，不覆盖** —— 这是用户明确要求。 */
create or replace function profile_summary_add(p_profile uuid, p_kind text, p_content text,
                                               p_from timestamptz default null,
                                               p_to timestamptz default null)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare v_id uuid;
begin
  perform acl_require('site.profile');
  if p_kind not in ('timeline', 'category', 'digest') then
    raise exception '整理形态必须是 timeline / category / digest';
  end if;
  if coalesce(trim(p_content), '') = '' then raise exception '整理内容为空'; end if;
  insert into profile_summaries (profile_id, kind, content, entry_from, entry_to)
  values (p_profile, p_kind, p_content, p_from, p_to)
  returning id into v_id;
  perform nextval('state_rev');
  return json_build_object('id', v_id);
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
      where profile_id = p_profile and kind = p_kind
      order by created_at desc
    ) x
  ), '[]'::json);
end;
$$;

/* 档案图片：申请槽位 + 校验（单独一套，逻辑 copy 自 media_objects） */
create or replace function profile_media_prepare(p_name text, p_size bigint)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; v_id uuid; v_path text;
begin
  perform acl_require('site.profile');
  uid := cur_user();
  /* 档案是站长自己用，上限仍要设 —— 不设的话一次误传就把库撑了。
     但因为自用，给得比较宽松：单张 20MB。 */
  if coalesce(p_size, 0) > 20 * 1024 * 1024 then
    raise exception '单张不能超过 20MB';
  end if;
  v_path := 'profiles/' || uid::text || '/' || replace(gen_random_uuid()::text, '-', '') || '_' || coalesce(p_name, 'f');
  insert into profile_media (uploader, name, size, path)
  values (uid, coalesce(p_name, ''), coalesce(p_size, 0), v_path)
  returning id into v_id;
  return json_build_object('id', v_id, 'path', v_path);
end;
$$;

create or replace function profile_media_allowed(p_path text)
returns boolean language sql stable security definer
set search_path = public, extensions, pg_temp as $$
  /* 同 S-071：必须校验主人，否则拿到 path 就能覆盖别人的图 */
  select exists (
    select 1 from profile_media
    where path = p_path
      and uploader = cur_user()
      and committed = false
      and created_at > now() - interval '15 minutes'
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
grant execute on function profile_get(uuid) to anon, authenticated;
grant execute on function profile_entry_add(uuid, text, text[]) to anon, authenticated;
grant execute on function profile_entry_del(uuid) to anon, authenticated;
grant execute on function profile_summary_add(uuid, text, text, timestamptz, timestamptz) to anon, authenticated;
grant execute on function profile_summary_history(uuid, text) to anon, authenticated;
grant execute on function profile_media_prepare(text, bigint) to anon, authenticated;
grant execute on function profile_media_allowed(text) to anon, authenticated;
grant execute on function profile_media_commit(text) to anon, authenticated;
