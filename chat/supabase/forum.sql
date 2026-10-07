-- ==================================================================
-- 贴吧建表脚本
-- 在 Supabase Dashboard → SQL Editor → New query 里整段粘贴执行
-- 可接在 schema.sql 之后跑，也可以单独跑（不依赖聊天室的那些表）
-- ==================================================================

create extension if not exists pgcrypto;

-- ---------- 主题帖 ----------
create table if not exists forum_posts (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null default '',
  author      text not null default '匿名',
  created_at  timestamptz not null default now()
);
create index if not exists forum_posts_time_idx on forum_posts (created_at desc);

-- ---------- 回复 ----------
create table if not exists forum_replies (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references forum_posts(id) on delete cascade,
  body       text not null default '',
  author     text not null default '匿名',
  created_at timestamptz not null default now()
);
create index if not exists forum_replies_post_idx on forum_replies (post_id, created_at);

-- ---------- RLS：默认全锁，只能通过下面的函数访问 ----------
alter table forum_posts   enable row level security;
alter table forum_replies enable row level security;

-- ==================================================================
-- 对外接口（只有这三个函数被授权执行）
-- ==================================================================

-- 列出全部帖子（含回复，按时间倒序）
create or replace function forum_list()
returns table (
  id uuid, title text, body text, author text,
  created_at timestamptz, replies json
)
language sql stable security definer as $$
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

-- 发新帖
create or replace function forum_post(p_title text, p_body text, p_author text)
returns uuid language plpgsql volatile security definer as $$
declare newid uuid;
begin
  if length(trim(coalesce(p_title, ''))) = 0 then raise exception '标题不能为空'; end if;
  if length(coalesce(p_title, '')) > 120 then raise exception '标题过长（上限 120 字）'; end if;
  if length(coalesce(p_body, '')) > 20000 then raise exception '正文过长（上限 20000 字）'; end if;
  insert into forum_posts (title, body, author)
  values (trim(p_title), coalesce(p_body, ''), coalesce(nullif(trim(p_author), ''), '匿名'))
  returning id into newid;
  return newid;
end;
$$;

-- 回复
create or replace function forum_reply(p_post uuid, p_body text, p_author text)
returns uuid language plpgsql volatile security definer as $$
declare newid uuid;
begin
  if not exists (select 1 from forum_posts where id = p_post) then
    raise exception '帖子不存在';
  end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception '回复内容不能为空'; end if;
  if length(coalesce(p_body, '')) > 10000 then raise exception '回复过长（上限 10000 字）'; end if;
  insert into forum_replies (post_id, body, author)
  values (p_post, trim(p_body), coalesce(nullif(trim(p_author), ''), '匿名'))
  returning id into newid;
  return newid;
end;
$$;

-- 删帖（凭作者名校验，防止误删他人帖子）
create or replace function forum_del(p_post uuid, p_author text)
returns boolean language plpgsql volatile security definer as $$
begin
  delete from forum_posts
  where id = p_post and author = coalesce(p_author, '');
  if not found then raise exception '只能删除自己发的帖子'; end if;
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
grant execute on function forum_del(uuid, text) to anon, authenticated;

-- ==================================================================
-- 保活：免费项目 7 天无数据库活动会被暂停。
-- 配合 .github/workflows/keep-alive.yml 定时调用 state_seq() 即可。
-- 若只用了贴吧、没跑 schema.sql，可改用下面这个：
--   select count(*) from forum_posts;
-- ==================================================================
