-- ==================================================================
-- 贴吧建表脚本
-- 在 Supabase Dashboard → SQL Editor → New query 里整段粘贴执行
--
-- ⚠ 依赖：本脚本【必须先跑完 schema.sql】再跑。
--   它复用聊天室的 users / sessions（统一身份），
--   用到 auth_uid() / auth_require() / auth_is_staff()。
--   单独跑会因找不到这些函数而失败 —— 这是有意为之，
--   目的是让贴吧与聊天室共用一套账号，而不是各建一套。
-- ==================================================================

create extension if not exists pgcrypto;

-- ---------- 主题帖 ----------
create table if not exists forum_posts (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null default '',
  author      text not null default '匿名',   -- 显示名（冗余，列表页免 join）
  author_id   uuid references users(id) on delete set null,  -- 统一身份：发帖人账号
  created_at  timestamptz not null default now()
);
create index if not exists forum_posts_time_idx on forum_posts (created_at desc);
create index if not exists forum_posts_author_idx on forum_posts (author_id);

-- ---------- 回复 ----------
create table if not exists forum_replies (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references forum_posts(id) on delete cascade,
  body       text not null default '',
  author     text not null default '匿名',
  author_id  uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists forum_replies_post_idx on forum_replies (post_id, created_at);

-- 已存在的旧库补列（幂等，重复执行安全）
alter table forum_posts   add column if not exists author_id uuid references users(id) on delete set null;
alter table forum_replies add column if not exists author_id uuid references users(id) on delete set null;

-- ---------- RLS：默认全锁，只能通过下面的函数访问 ----------
alter table forum_posts   enable row level security;
alter table forum_replies enable row level security;

-- ==================================================================
-- 对外接口
--
-- 权限模型（改造后）：
--   forum_list   公开可读（贴吧是公开区，且总发布页要展示）
--   forum_post   必须登录（auth_require）
--   forum_reply  必须登录
--   forum_del    本人或管理员
--
-- 改造前的漏洞：三个写操作都对 anon 开放且不校验会话，
--   任何人拿到 publishable key 就能绕过站点保护密码随意发；
--   forum_del 靠「作者名字符串」校验，而作者名在 forum_list 里就能看到
--   → 实质可以删任何人的帖子。
-- ==================================================================

-- 列出全部帖子（含回复，按时间倒序）—— 公开只读
create or replace function forum_list()
returns table (
  id uuid, title text, body text, author text,
  created_at timestamptz, replies json
)
language sql stable security definer
set search_path = public, pg_temp as $$
  select p.id, p.title, p.body, p.author, p.created_at,
         coalesce((
           select json_agg(json_build_object(
             'id', r.id, 'body', r.body, 'author', r.author,
             'ts', (extract(epoch from r.created_at) * 1000)::bigint
           ) order by r.created_at)
           from forum_replies r where r.post_id = p.id
         ), '[]'::json) as replies
  from forum_posts p
  order by p.created_at desc;
$$;

-- 发新帖（必须登录）
create or replace function forum_post(p_title text, p_body text, p_author text)
returns uuid language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare newid uuid; uid uuid; nick text;
begin
  uid := auth_require();                       -- 未登录直接抛错
  if length(trim(coalesce(p_title, ''))) = 0 then raise exception '标题不能为空'; end if;
  if length(coalesce(p_title, '')) > 120 then raise exception '标题过长（上限 120 字）'; end if;
  if length(coalesce(p_body, '')) > 20000 then raise exception '正文过长（上限 20000 字）'; end if;

  -- 显示名优先用账号昵称，避免冒名
  select u.nick into nick from users u where u.id = uid;
  insert into forum_posts (title, body, author, author_id)
  values (trim(p_title), coalesce(p_body, ''),
          coalesce(nullif(trim(coalesce(p_author, '')), ''), nick, '匿名'), uid)
  returning id into newid;
  return newid;
end;
$$;

-- 回复（必须登录）
create or replace function forum_reply(p_post uuid, p_body text, p_author text)
returns uuid language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare newid uuid; uid uuid; nick text;
begin
  uid := auth_require();
  if not exists (select 1 from forum_posts where id = p_post) then
    raise exception '帖子不存在';
  end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception '回复内容不能为空'; end if;
  if length(coalesce(p_body, '')) > 10000 then raise exception '回复过长（上限 10000 字）'; end if;

  select u.nick into nick from users u where u.id = uid;
  insert into forum_replies (post_id, body, author, author_id)
  values (p_post, trim(p_body),
          coalesce(nullif(trim(coalesce(p_author, '')), ''), nick, '匿名'), uid)
  returning id into newid;
  return newid;
end;
$$;

-- 删帖：本人或管理员。
-- 不再用「作者名字符串」校验 —— 那个名字是公开的，等于没有校验。
create or replace function forum_del(p_post uuid)
returns boolean language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare uid uuid;
begin
  uid := auth_require();
  delete from forum_posts
  where id = p_post
    and (author_id = uid or auth_is_staff());
  if not found then raise exception '只能删除自己发的帖子'; end if;
  return true;
end;
$$;

-- 删回复：本人或管理员
create or replace function forum_del_reply(p_reply uuid)
returns boolean language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare uid uuid;
begin
  uid := auth_require();
  delete from forum_replies
  where id = p_reply
    and (author_id = uid or auth_is_staff());
  if not found then raise exception '只能删除自己的回复'; end if;
  return true;
end;
$$;

-- ==================================================================
-- 权限：只授予执行，不授予任何表的直接读写
-- ==================================================================
revoke all on forum_posts   from anon, authenticated;
revoke all on forum_replies from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant execute on function forum_list() to anon, authenticated;
grant execute on function forum_post(text, text, text) to anon, authenticated;
grant execute on function forum_reply(uuid, text, text) to anon, authenticated;
grant execute on function forum_del(uuid) to anon, authenticated;
grant execute on function forum_del_reply(uuid) to anon, authenticated;

-- ==================================================================
-- 保活：免费项目 7 天无数据库活动会被暂停。
-- 配合 .github/workflows/keep-alive.yml 定时调用 state_seq() 即可。
-- 若只用了贴吧、没跑 schema.sql，可改用下面这个：
--   select count(*) from forum_posts;
-- ==================================================================
