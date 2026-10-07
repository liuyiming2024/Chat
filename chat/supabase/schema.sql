-- ==================================================================
-- 聊天室 —— Supabase 建库脚本
-- 在 Supabase Dashboard → SQL Editor → New query 里整段粘贴执行
--
-- 安全设计（重要）：
--   1. 所有表都不直接开放给 anon，只暴露 SECURITY DEFINER 的 RPC 函数。
--      即使 publishable key 公开，没有站点保护密码也拿不到任何数据。
--   2. 密码一律用 pgcrypto 的 bcrypt 在数据库内处理，
--      前端永远拿不到任何人的 pwd_hash / salt。
--   3. 会话 token 由服务端签发，通过 x-session 请求头传递。
-- ==================================================================

create extension if not exists pgcrypto;

-- ---------- 站点配置（单行） ----------
create table if not exists site (
  id            boolean primary key default true check (id),
  site_name     text not null default '聊天室',
  gate_hash     text,                       -- 站点保护密码（bcrypt），为空表示未初始化
  allow_register boolean not null default true,
  created_at    timestamptz not null default now()
);
insert into site (id) values (true) on conflict (id) do nothing;

-- ---------- 用户 ----------
create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  nick        text not null unique,
  real_name   text not null default '',     -- 实名，线下审核用
  pwd_hash    text not null,                -- bcrypt
  role        text not null default 'member', -- owner / admin / member
  status      text not null default 'pending', -- pending 待审核 / active / banned
  perms       text[] not null default '{}',
  muted_until timestamptz,
  bio         text not null default '',
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);
create index if not exists users_nick_idx on users (lower(nick));

-- ---------- 会话 ----------
create table if not exists sessions (
  token       text primary key,
  user_id     uuid references users(id) on delete cascade,
  gate_ok     boolean not null default false, -- 仅通过保护密码、尚未登录账号
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions (user_id);

-- ---------- 房间 ----------
create table if not exists rooms (
  id         text primary key,               -- public / r_xxx / dm:xxx-xxx
  name       text not null,
  type       text not null default 'group',  -- public / group / private
  owner_id   uuid references users(id) on delete set null,
  description text not null default '',
  notice     text not null default '',
  pwd_hash   text,                            -- 群密码（bcrypt），可空
  created_at timestamptz not null default now()
);

create table if not exists room_members (
  room_id text references rooms(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  primary key (room_id, user_id)
);

create table if not exists room_admins (
  room_id text references rooms(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  primary key (room_id, user_id)
);

-- ---------- 消息 ----------
create table if not exists messages (
  id         uuid primary key default gen_random_uuid(),
  room_id    text not null references rooms(id) on delete cascade,
  from_id    uuid references users(id) on delete set null,
  type       text not null default 'text',   -- text / image / video / system
  body       text not null default '',
  media_path text,
  media_name text not null default '',
  media_size bigint not null default 0,
  reply_to   uuid,
  deleted    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists messages_room_idx on messages (room_id, created_at);

-- ---------- 操作日志 ----------
create table if not exists logs (
  id         uuid primary key default gen_random_uuid(),
  who_id     uuid references users(id) on delete set null,
  act        text not null,
  detail     text not null default '',
  target     text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists logs_time_idx on logs (created_at desc);

-- ---------- 单调递增序号（供前端判断是否有更新） ----------
create sequence if not exists state_rev;

-- ==================================================================
-- 全部启用 RLS 且不授予 anon 任何权限 —— 数据只能经 RPC 访问
-- ==================================================================
alter table site         enable row level security;
alter table users        enable row level security;
alter table sessions     enable row level security;
alter table rooms        enable row level security;
alter table room_members enable row level security;
alter table room_admins  enable row level security;
alter table messages     enable row level security;
alter table logs         enable row level security;

-- ==================================================================
-- 内部辅助函数
-- ==================================================================

-- 读取请求头中的会话 token
create or replace function cur_token() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.headers', true)::json->>'x-session', ''),
    ''
  );
$$;

create or replace function new_token() returns text
language sql volatile as $$
  select encode(gen_random_bytes(24), 'hex');
$$;

-- 当前登录用户（未登录返回 null）
create or replace function cur_user() returns uuid
language sql stable as $$
  select s.user_id from sessions s
  where s.token = cur_token() and s.expires_at > now() and s.user_id is not null
  limit 1;
$$;

-- 是否已通过站点保护密码
create or replace function gate_passed() returns boolean
language sql stable as $$
  select exists (
    select 1 from site where gate_hash is null
  ) or exists (
    select 1 from sessions s
    where s.token = cur_token() and s.expires_at > now() and s.gate_ok
  );
$$;

-- 生成会话（gate_ok=true 表示仅过了保护密码）
create or replace function issue_session(uid uuid, gate_only boolean default false)
returns text language plpgsql volatile as $$
declare tk text;
begin
  tk := new_token();
  insert into sessions (token, user_id, gate_ok, expires_at)
  values (tk, uid, coalesce(gate_only, false), now() + interval '30 days');
  return tk;
end;
$$;

-- ==================================================================
-- 对外 RPC（这些是唯一被授予执行权限的接口）
-- ==================================================================

-- 站点是否已初始化
create or replace function site_ready() returns boolean
language sql stable as $$
  select exists (select 1 from site where gate_hash is not null);
$$;

-- 序号：前端轮询比对，也用于 Actions 保活
create or replace function state_seq() returns bigint
language sql volatile as $$
  select nextval('state_rev');
$$;

-- 站点初始化：设保护密码 + 建站长（仅当未初始化时可用）
create or replace function site_init(p_gate text, p_nick text, p_real text, p_pwd text)
returns json language plpgsql volatile security definer as $$
declare uid uuid; tk text;
begin
  if exists (select 1 from site where gate_hash is not null) then
    raise exception '站点已初始化';
  end if;
  if length(p_gate) < 4 or length(p_pwd) < 4 then
    raise exception '密码至少 4 位';
  end if;
  insert into users (nick, real_name, pwd_hash, role, status)
  values (p_nick, p_real, crypt(p_pwd, gen_salt('bf', 8)), 'owner', 'active')
  returning id into uid;

  insert into rooms (id, name, type, notice) values (
    'public', '公屏大厅', 'public',
    E'欢迎来到**公屏大厅**！\n\n- 支持 Markdown 与 `$E=mc^2$` 行内公式\n- 支持 `$$\\frac{a}{b}$$` 块级公式\n- 输入 `/help` 查看全部命令'
  ) on conflict (id) do nothing;

  update site set gate_hash = crypt(p_gate, gen_salt('bf', 8)) where id = true;

  insert into logs (who_id, act, detail) values (uid, 'init', '创建站点与站长 ' || p_nick);
  tk := issue_session(uid, false);
  return json_build_object('token', tk, 'uid', uid);
end;
$$;

-- 校验保护密码（通过后会话可读取站点公开信息）
create or replace function gate_check(p text)
returns text language plpgsql volatile security definer as $$
declare tk text;
begin
  if not exists (select 1 from site where gate_hash = crypt(p, gate_hash)) then
    raise exception '保护密码错误';
  end if;
  tk := issue_session(null, true);
  return tk;
end;
$$;

-- 注册（默认 pending，需站长线下审核通过）
create or replace function user_register(p_nick text, p_real text, p_pwd text)
returns json language plpgsql volatile security definer as $$
declare uid uuid; cnt int;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
  if not (select allow_register from site where id = true) then
    raise exception '当前未开放注册';
  end if;
  if length(p_nick) < 1 or length(p_real) < 1 then raise exception '请填写昵称与真实姓名'; end if;
  if length(p_pwd) < 4 then raise exception '密码至少 4 位'; end if;
  select count(*) into cnt from users where lower(nick) = lower(p_nick);
  if cnt > 0 then raise exception '昵称已被占用'; end if;

  insert into users (nick, real_name, pwd_hash, role, status)
  values (p_nick, p_real, crypt(p_pwd, gen_salt('bf', 8)), 'member', 'pending')
  returning id into uid;

  -- 站长账号自动通过；普通账号待审核
  insert into logs (who_id, act, detail) values (uid, 'register', p_nick || '（' || p_real || '）待审核');
  return json_build_object('uid', uid, 'status', 'pending');
end;
$$;

-- 登录
create or replace function user_login(p_nick text, p_pwd text)
returns json language plpgsql volatile security definer as $$
declare u record; tk text;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
  select * into u from users where lower(nick) = lower(p_nick);
  if not found then raise exception '昵称或密码错误'; end if;
  if u.pwd_hash <> crypt(p_pwd, u.pwd_hash) then raise exception '昵称或密码错误'; end if;
  if u.status = 'banned' then raise exception '该账号已被封禁'; end if;
  if u.status = 'pending' then raise exception '账号待站长审核，请稍候'; end if;

  update users set last_seen = now() where id = u.id;
  tk := issue_session(u.id, false);
  return json_build_object('token', tk, 'uid', u.id,
    'nick', u.nick, 'real_name', u.real_name, 'role', u.role);
end;
$$;

-- 拉取全量状态（需已通过保护密码）
create or replace function state_get()
returns json language plpgsql stable security definer as $$
declare me uuid;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
  me := cur_user();
  return json_build_object(
    'me', me,
    'site', (select row_to_json(s) from (
      select site_name, allow_register, (gate_hash is not null) as has_gate from site where id = true) s),
    'users', coalesce((select json_agg(json_build_object(
        'id', u.id, 'nick', u.nick, 'realName', u.real_name, 'role', u.role,
        'status', u.status, 'perms', u.perms, 'bio', u.bio,
        'mutedUntil', (extract(epoch from u.muted_until) * 1000)::bigint,
        'createdAt', (extract(epoch from u.created_at) * 1000)::bigint,
        'lastSeen', (extract(epoch from u.last_seen) * 1000)::bigint
      )) from users u), '[]'::json),
    'rooms', coalesce((select json_agg(r) from (
      select json_build_object(
        'id', rm.id, 'name', rm.name, 'type', rm.type, 'owner', rm.owner_id,
        'desc', rm.description, 'notice', rm.notice,
        'hasPwd', (rm.pwd_hash is not null),
        'createdAt', (extract(epoch from rm.created_at) * 1000)::bigint,
        'members', coalesce((select json_agg(mm.user_id) from room_members mm where mm.room_id = rm.id), '[]'::json),
        'admins', coalesce((select json_agg(aa.user_id) from room_admins aa where aa.room_id = rm.id), '[]'::json)
      ) as r from rooms rm) x), '[]'::json),
    'messages', coalesce((select json_agg(json_build_object(
        'id', m.id, 'room', m.room_id, 'from', m.from_id, 'type', m.type,
        'text', m.body, 'mediaId', m.media_path, 'name', m.media_name,
        'size', m.media_size, 'replyTo', m.reply_to,
        'deleted', m.deleted,
        'ts', (extract(epoch from m.created_at) * 1000)::bigint
      )) from messages m where m.created_at > now() - interval '30 days'
        order by m.created_at), '[]'::json),
    'logs', coalesce((select json_agg(json_build_object(
        'id', l.id, 'who', l.who_id, 'act', l.act, 'detail', l.detail,
        'target', l.target, 'ts', (extract(epoch from l.created_at) * 1000)::bigint
      )) from (select * from logs order by created_at desc limit 200) l), '[]'::json)
  );
end;
$$;

-- 写回消息（前端把新增消息交给服务端）
create or replace function msg_send(
  p_room text, p_type text, p_body text,
  p_media text default null, p_name text default '', p_size bigint default 0,
  p_reply uuid default null
) returns json language plpgsql volatile security definer as $$
declare uid uuid; mid uuid; st text;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  select status into st from users where id = uid;
  if st <> 'active' then raise exception '账号未通过审核'; end if;
  if exists (select 1 from users where id = uid and muted_until > now()) then
    raise exception '你已被禁言';
  end if;
  if not exists (
    select 1 from rooms r where r.id = p_room
      and (r.type = 'public' or exists (select 1 from room_members mm where mm.room_id = r.id and mm.user_id = uid))
  ) then raise exception '无权在该房间发言'; end if;

  insert into messages (room_id, from_id, type, body, media_path, media_name, media_size, reply_to)
  values (p_room, uid, p_type, coalesce(p_body,''), p_media, p_name, coalesce(p_size,0), p_reply)
  returning id into mid;
  perform nextval('state_rev');
  return json_build_object('id', mid);
end;
$$;

-- 撤回 / 删除消息
create or replace function msg_delete(p_id uuid)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid; r record;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  select * into r from messages where id = p_id;
  if not found then return false; end if;
  if r.from_id = uid then
    update messages set deleted = true, body = '', media_path = null where id = p_id;
    perform nextval('state_rev');
    return true;
  end if;
  if exists (select 1 from users where id = uid and role in ('owner','admin')) then
    update messages set deleted = true, body = '', media_path = null where id = p_id;
    insert into logs (who_id, act, detail) values (uid, 'delete', '删除消息 ' || p_id);
    perform nextval('state_rev');
    return true;
  end if;
  raise exception '无权删除该消息';
end;
$$;

-- 建群
create or replace function room_create(p_name text, p_desc text default '', p_pwd text default null)
returns text language plpgsql volatile security definer as $$
declare uid uuid; rid text;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception '群名不能为空'; end if;
  rid := 'r_' || encode(gen_random_bytes(6), 'hex');
  insert into rooms (id, name, type, owner_id, description, pwd_hash)
  values (rid, p_name, 'group', uid, coalesce(p_desc,''),
          case when nullif(p_pwd,'') is null then null else crypt(p_pwd, gen_salt('bf', 8)) end);
  insert into room_members (room_id, user_id) values (rid, uid);
  perform nextval('state_rev');
  return rid;
end;
$$;

-- 私聊房间（不存在则创建）
create or replace function room_dm(p_other uuid)
returns text language plpgsql volatile security definer as $$
declare uid uuid; rid text;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  rid := 'dm:' || (select string_agg(x, '-' order by x) from (select unnest(array[uid::text, p_other::text]) as x) t);
  insert into rooms (id, name, type) values (rid, '私聊', 'private')
    on conflict (id) do nothing;
  insert into room_members (room_id, user_id) values (rid, uid), (rid, p_other)
    on conflict do nothing;
  perform nextval('state_rev');
  return rid;
end;
$$;

-- 加入房间（带密码校验）
create or replace function room_join(p_room text, p_pwd text default null)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid; r record;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  select * into r from rooms where id = p_room;
  if not found then raise exception '房间不存在'; end if;
  if r.pwd_hash is not null then
    if p_pwd is null or r.pwd_hash <> crypt(p_pwd, r.pwd_hash) then
      raise exception '房间密码错误';
    end if;
  end if;
  insert into room_members (room_id, user_id) values (p_room, uid) on conflict do nothing;
  perform nextval('state_rev');
  return true;
end;
$$;

-- 退出房间
create or replace function room_leave(p_room text)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  delete from room_members where room_id = p_room and user_id = uid;
  delete from room_admins  where room_id = p_room and user_id = uid;
  perform nextval('state_rev');
  return true;
end;
$$;

-- 房间设置：公告 / 简介 / 密码
create or replace function room_update(
  p_room text, p_name text default null, p_notice text default null,
  p_desc text default null, p_pwd text default null
) returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (
    select 1 from rooms r where r.id = p_room and (
      r.owner_id = uid or exists (select 1 from room_admins a where a.room_id = r.id and a.user_id = uid)
      or exists (select 1 from users u where u.id = uid and u.role in ('owner','admin'))
    )
  ) then raise exception '无权修改该房间'; end if;

  update rooms set
    name     = coalesce(p_name, name),
    notice   = coalesce(p_notice, notice),
    description = coalesce(p_desc, description),
    pwd_hash = case when p_pwd is null then pwd_hash
                    when p_pwd = '' then null
                    else crypt(p_pwd, gen_salt('bf', 8)) end
  where id = p_room;
  perform nextval('state_rev');
  return true;
end;
$$;

-- 解散房间
create or replace function room_delete(p_room text)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (
    select 1 from rooms r where r.id = p_room and (
      r.owner_id = uid
      or exists (select 1 from users u where u.id = uid and u.role in ('owner','admin'))
    )
  ) then raise exception '无权解散该房间'; end if;
  delete from rooms where id = p_room;
  perform nextval('state_rev');
  return true;
end;
$$;

-- 成员管理：邀请 / 移出 / 设管理员 / 取消管理员
create or replace function member_add(p_room text, p_user uuid)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (
    select 1 from rooms r where r.id = p_room and (
      r.owner_id = uid or exists (select 1 from room_admins a where a.room_id = r.id and a.user_id = uid)
      or exists (select 1 from users u where u.id = uid and u.role in ('owner','admin'))
    )
  ) then raise exception '无权操作'; end if;
  insert into room_members (room_id, user_id) values (p_room, p_user) on conflict do nothing;
  perform nextval('state_rev');
  return true;
end;
$$;

create or replace function member_remove(p_room text, p_user uuid)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (
    select 1 from rooms r where r.id = p_room and (
      r.owner_id = uid or exists (select 1 from room_admins a where a.room_id = r.id and a.user_id = uid)
      or exists (select 1 from users u where u.id = uid and u.role in ('owner','admin'))
    )
  ) then raise exception '无权操作'; end if;
  delete from room_admins  where room_id = p_room and user_id = p_user;
  delete from room_members where room_id = p_room and user_id = p_user;
  perform nextval('state_rev');
  return true;
end;
$$;

create or replace function member_admin(p_room text, p_user uuid, p_on boolean)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (
    select 1 from rooms r where r.id = p_room and (
      r.owner_id = uid
      or exists (select 1 from users u where u.id = uid and u.role in ('owner','admin'))
    )
  ) then raise exception '无权授权管理员'; end if;
  if p_on then
    insert into room_admins (room_id, user_id) values (p_room, p_user) on conflict do nothing;
  else
    delete from room_admins where room_id = p_room and user_id = p_user;
  end if;
  perform nextval('state_rev');
  return true;
end;
$$;

-- 用户管理：审核 / 封禁 / 禁言 / 改角色 / 改权限
create or replace function user_review(p_user uuid, p_status text)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (select 1 from users u where u.id = uid and u.role in ('owner','admin')) then
    raise exception '仅管理员可审核';
  end if;
  if p_status not in ('active','pending','banned') then raise exception '状态不合法'; end if;
  update users set status = p_status where id = p_user;
  insert into logs (who_id, act, detail) values (uid, 'review', p_status || ' ' || p_user);
  perform nextval('state_rev');
  return true;
end;
$$;

create or replace function user_mute(p_user uuid, p_minutes int)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (select 1 from users u where u.id = uid and u.role in ('owner','admin')) then
    raise exception '仅管理员可禁言';
  end if;
  update users set muted_until =
    case when coalesce(p_minutes,0) <= 0 then null else now() + (p_minutes || ' minutes')::interval end
  where id = p_user;
  insert into logs (who_id, act, detail) values (uid, 'mute', coalesce(p_minutes,0) || '分钟');
  perform nextval('state_rev');
  return true;
end;
$$;

create or replace function user_role_set(p_user uuid, p_role text)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (select 1 from users u where u.id = uid and u.role = 'owner') then
    raise exception '仅站长可调整角色';
  end if;
  if p_role not in ('owner','admin','member') then raise exception '角色不合法'; end if;
  -- 转让站长：原站长降为管理员
  if p_role = 'owner' then
    update users set role = 'admin' where id = uid;
  end if;
  update users set role = p_role where id = p_user;
  insert into logs (who_id, act, detail) values (uid, 'role', p_user || ' → ' || p_role);
  perform nextval('state_rev');
  return true;
end;
$$;

create or replace function user_perms_set(p_user uuid, p_perms text[])
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (select 1 from users u where u.id = uid and u.role = 'owner') then
    raise exception '仅站长可调整权限';
  end if;
  update users set perms = coalesce(p_perms, '{}') where id = p_user;
  insert into logs (who_id, act, detail) values (uid, 'perm', p_user::text || ': ' || array_to_string(coalesce(p_perms,'{}'), ','));
  perform nextval('state_rev');
  return true;
end;
$$;

create or replace function user_delete(p_user uuid)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (select 1 from users u where u.id = uid and u.role = 'owner') then
    raise exception '仅站长可删除用户';
  end if;
  if p_user = uid then raise exception '不能删除自己'; end if;
  delete from users where id = p_user;
  perform nextval('state_rev');
  return true;
end;
$$;

-- 个人资料
create or replace function profile_update(p_nick text default null, p_real text default null,
                                          p_bio text default null)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if p_nick is not null and exists (select 1 from users where lower(nick)=lower(p_nick) and id<>uid) then
    raise exception '昵称已被占用';
  end if;
  update users set
    nick = coalesce(p_nick, nick),
    real_name = coalesce(p_real, real_name),
    bio = coalesce(p_bio, bio)
  where id = uid;
  perform nextval('state_rev');
  return true;
end;
$$;

create or replace function user_password(p_old text, p_new text)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid; u record;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  select * into u from users where id = uid;
  if u.pwd_hash <> crypt(p_old, u.pwd_hash) then raise exception '原密码错误'; end if;
  if length(p_new) < 4 then raise exception '新密码至少 4 位'; end if;
  update users set pwd_hash = crypt(p_new, gen_salt('bf', 8)) where id = uid;
  return true;
end;
$$;

create or replace function gate_set(p_old text, p_new text)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (select 1 from users u where u.id = uid and u.role in ('owner','admin')) then
    raise exception '仅管理员可修改保护密码';
  end if;
  if not exists (select 1 from site where gate_hash = crypt(p_old, gate_hash)) then
    raise exception '原保护密码错误';
  end if;
  if length(p_new) < 4 then raise exception '新密码至少 4 位'; end if;
  update site set gate_hash = crypt(p_new, gen_salt('bf', 8)) where id = true;
  insert into logs (who_id, act, detail) values (uid, 'gate', '修改保护密码');
  return true;
end;
$$;

create or replace function site_set(p_name text default null, p_allow_register boolean default null)
returns boolean language plpgsql volatile security definer as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (select 1 from users u where u.id = uid and u.role in ('owner','admin')) then
    raise exception '仅管理员可修改站点设置';
  end if;
  update site set
    site_name = coalesce(p_name, site_name),
    allow_register = coalesce(p_allow_register, allow_register)
  where id = true;
  perform nextval('state_rev');
  return true;
end;
$$;

-- 退出登录
create or replace function logout()
returns boolean language plpgsql volatile security definer as $$
begin
  delete from sessions where token = cur_token();
  return true;
end;
$$;

-- ==================================================================
-- 权限：只授予执行 RPC，不授予任何表的读写
-- ==================================================================
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant execute on all functions in schema public to anon, authenticated;

-- Storage：媒体桶
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;
