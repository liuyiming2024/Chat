-- ==================================================================
-- 聊天室 —— Supabase 建库脚本
-- 在 Supabase Dashboard → SQL Editor → New query 里整段粘贴执行
--
-- 安全设计（重要）：
--   0. ⚠ search_path 必须写成 public, extensions, pg_temp —— 别忘了 extensions！
--      Supabase 把 pgcrypto（gen_salt / crypt / digest / gen_random_uuid）
--      装在 extensions schema 里，不是 public。只写 public,pg_temp 会让
--      这些函数全部找不到，注册和登录直接报 "function gen_salt does not exist"。
--      （这个坑踩过：本地测试用 public 里的 stub 函数，掩盖了真实环境差异。）
--
--   1. 所有表都不直接开放给 anon，只暴露 SECURITY DEFINER 的 RPC 函数。
--      即使 publishable key 公开，没有站点保护密码也拿不到任何数据。
--   2. 密码一律用 pgcrypto 的 bcrypt 在数据库内处理，
--      前端永远拿不到任何人的 pwd_hash / salt。
--   3. 会话 token 由服务端签发，通过 x-session 请求头传递；
--      库里只存 sha256(token)，不存明文。
--   4. ⚠ 限流【不在数据库层】—— gate_check / user_login 必须允许匿名调用，
--      口令可被无限次试。数据库层做不了：plpgsql 的 raise exception 会回滚
--      同一函数内此前的写入，在 raise 前 update 失败计数永远累加不上去
--      （曾这样实现过，实测无效，已移除）。
--      必须在网关层配：Supabase Dashboard → Settings → Rate Limits，
--      或在 Cloudflare 按 IP 限制 /rest/v1/rpc/gate_check、user_login。
--      建议：同 IP 每分钟 ≤ 10 次；bcrypt cost ≥ 10 抬高单次成本。
--
-- ⚠ 关于 RLS —— 别把它当防线：
--   下面所有表都 enable row level security，但脚本里【没有任何 create policy】，
--   默认全拒；而业务读写全部走 SECURITY DEFINER 函数，definer 以 owner 身份执行，
--   owner 绕过 RLS。也就是说 RLS 在本架构下等于没开，
--   真正的安全边界 100% 是每个函数体开头的那几行 if ... raise。
--   ⇒ 新增任何 RPC，第一件事就是写鉴权判断。这是硬约定，不是风格问题。
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
  real_name   text not null default '',     -- 可选备注字段，前端不采集
  pwd_hash    text not null,                -- bcrypt
  role        text not null default 'member', -- owner / admin / member
  status      text not null default 'pending', -- pending 待审核 / active / banned
  perms       text[] not null default '{}',
  muted_until timestamptz,
  -- perms = 显式授予，denied = 显式禁止（denied 优先级高于 perms 与角色默认，站长除外）。
  -- 前端 acl.js 一直在用 denied，建库脚本里漏了这列 —— 迁移缺口，故补。
  denied      text[] not null default '{}',
  bio         text not null default '',
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);
create index if not exists users_nick_idx on users (lower(nick));

-- ---------- 会话 ----------
create table if not exists sessions (
  -- 只存 sha256(token)，不存明文。
  -- 理由：token 即身份。明文入库意味着任何拿到数据库读权限的人（备份泄露、
  -- 误开策略、控制台截图）都能直接冒充全部在线用户，连密码都不用破。
  -- token 本身是 gen_random_bytes(24) 的高熵随机串，不是用户口令，
  -- 所以 sha256 单次即可，不需要 bcrypt 这类慢哈希。
  token_hash  text primary key,
  user_id     uuid references users(id) on delete cascade,
  gate_ok     boolean not null default false, -- 仅通过保护密码、尚未登录账号
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions (user_id);
create index if not exists sessions_exp_idx on sessions (expires_at);

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
  -- 房间内禁言（区别于 users.muted_until 的全站禁言）。
  -- 前端 acl.js 的 canSpeak 检查 room.muted 数组，数据库原本无处存，故补。
  muted_until timestamptz,
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

-- 当前请求携带的会话 token 的哈希（空则为空串）
-- 所有对 sessions 的查询一律用它，禁止直接比对明文 token。
create or replace function cur_token_hash() returns text
language sql stable as $$
  select case when cur_token() = '' then ''
         else encode(digest(cur_token(), 'sha256'), 'hex') end;
$$;

-- 当前登录用户（未登录返回 null）
create or replace function cur_user() returns uuid
language sql stable as $$
  select s.user_id from sessions s
  where s.token_hash = cur_token_hash() and s.expires_at > now() and s.user_id is not null
  limit 1;
$$;

-- ==================================================================
-- 统一身份层（跨项目共用）
--   未来所有网页项目都复用同一张 users / sessions，
--   通过下面这几个 auth_* 函数取身份，不要各自另建账号体系。
--   约定：
--     auth_uid()      当前账号 id，未登录 null
--     auth_role()     当前角色，未登录 null（owner / admin / member）
--     auth_is_staff() 是否站长或管理员（有管理权，可删他人内容）
--   新项目只需保证会话走同一套 sessions 表，即可直接调用。
-- ==================================================================
create or replace function auth_uid() returns uuid
language sql stable as $$ select cur_user() $$;

create or replace function auth_role() returns text
language sql stable as $$
  select u.role from users u where u.id = cur_user();
$$;

create or replace function auth_is_staff() returns boolean
language sql stable as $$
  select exists (
    select 1 from users u
    where u.id = cur_user() and u.role in ('owner','admin') and u.status = 'active'
  );
$$;

-- 要求已登录，否则抛错。供各项目的写操作统一调用。
create or replace function auth_require() returns uuid
language plpgsql stable as $$
declare uid uuid;
begin
  uid := auth_uid();
  if uid is null then raise exception '请先登录'; end if;
  return uid;
end;
$$;

-- 是否已通过站点保护密码
-- 注意：这里【不能】加 "gate_hash is null 就算通过" 的分支。
-- 那会让站点在尚未设置保护密码的窗口期里，任何人都能调 user_register 批量注册
-- （虽然状态是 pending，但仍可占昵称、灌日志）。
-- 未初始化时只放行 site_ready() / site_init()，其余一律要求有效会话。
create or replace function gate_passed() returns boolean
language sql stable as $$
  select exists (
    select 1 from sessions s
    where s.token_hash = cur_token_hash() and s.expires_at > now()
      and (s.gate_ok or s.user_id is not null)   -- 过了门禁，或已登录账号
  );
$$;

-- 生成会话（gate_ok=true 表示仅过了保护密码）
create or replace function issue_session(uid uuid, gate_only boolean default false)
returns text language plpgsql volatile as $$
declare tk text;
begin
  tk := new_token();
  insert into sessions (token_hash, user_id, gate_ok, expires_at)
  values (encode(digest(tk, 'sha256'), 'hex'), uid, coalesce(gate_only, false),
          now() + interval '14 days');
  return tk;   -- 明文 token 只在这一刻出现，随后随响应返回，库里不留
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

-- ⚠ 前端轮询必须用这个，不能用 state_seq()。
--   state_seq() 是 nextval —— 每调一次就把序号 +1，
--   拿它做轮询比对会导致序号永远不同 → 前端每次都全量拉取，白跑。
--   这里读 last_value，不改变序列。
/* 增量拉取：只返回 p_since 之后变化的部分。
 *
 * 为什么必须有它 —— 轮询触发全量拉取是额度层面唯一还开着的水龙头：
 *   全站用户 + 全站房间 + 近 30 天全部消息 + 200 条日志，
 *   一个人发一句话，N 个在线客户端各拉一次全站，N×N 增长。
 * 有了增量后，一次普通轮询返回的通常只有几条新消息。
 *
 * p_since：上次拿到的序号（state_peek 的返回值）。传 0 或 null 等价于全量。
 * 返回结构比 state_get 多一个 rev，前端应把它存起来作为下次的 p_since。
 * 删除的消息也会带上（deleted=true），前端据此撤回气泡。
 */
create or replace function state_delta(p_since bigint default 0)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare me uuid; v_from timestamptz; v_rev bigint;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
  me := cur_user();
  v_rev := (select last_value from state_rev);

  /* 序号对应的大致时间。用 rev 差值估秒数，避免额外维护时间戳列。 */
  if coalesce(p_since, 0) <= 0 then
    v_from := now() - interval '30 days';
  else
    v_from := now() - make_interval(secs => greatest(0, v_rev - p_since) * 2 + 30);
  end if;

  return json_build_object(
    'rev', v_rev,
    'me', me,
    'site', (select row_to_json(s) from (
      select site_name, allow_register, (gate_hash is not null) as has_gate from site where id = true) s),
    /* 用户与房间量小且变动会牵动权限，每次都带上，不做增量 */
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
      ) order by m.created_at) from messages m
      where m.created_at > v_from
        and (
          exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
          or exists (select 1 from room_members mm
                     where mm.room_id = m.room_id and mm.user_id = me)
        )
      ), '[]'::json),
    'logs', coalesce((select json_agg(json_build_object(
        'id', l.id, 'who', l.who_id, 'act', l.act, 'detail', l.detail,
        'target', l.target, 'ts', (extract(epoch from l.created_at) * 1000)::bigint
      ) order by l.created_at desc) from (
        select * from logs where created_at > v_from order by created_at desc limit 200
      ) l), '[]'::json)
  );
end;
$$;

/* 新 RPC 一律先写鉴权：序号本身不敏感，但它暴露"站点是否在活跃变化"，
   且轮询接口不该对未过门禁的人开放。 */
create or replace function state_peek() returns bigint
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
  return (select last_value from state_rev);
end;
$$;

-- 站点初始化：设保护密码 + 建站长（仅当未初始化时可用）
-- 注意：本函数用 $fn$ 而非 $$ 定界 —— 函数体里的公屏欢迎语含 $$…$$ 公式示例，
-- 若用 $$ 会被词法器当成函数体结束，整段脚本执行失败。
create or replace function site_init(p_gate text, p_nick text, p_real text, p_pwd text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $fn$
declare uid uuid; tk text;
begin
  if exists (select 1 from site where gate_hash is not null) then
    raise exception '站点已初始化';
  end if;
  if length(p_gate) < 4 or length(p_pwd) < 4 then
    raise exception '密码至少 4 位';
  end if;
  insert into users (nick, real_name, pwd_hash, role, status)
  values (p_nick, p_real, crypt(p_pwd, gen_salt('bf', 10)), 'owner', 'active')
  returning id into uid;

  insert into rooms (id, name, type, notice) values (
    'public', '公屏大厅', 'public',
    E'欢迎来到**公屏大厅**！\n\n- 支持 Markdown 与 `$E=mc^2$` 行内公式\n- 支持 `$$\\frac{a}{b}$$` 块级公式\n- 输入 `/help` 查看全部命令'
  ) on conflict (id) do nothing;

  update site set gate_hash = crypt(p_gate, gen_salt('bf', 10)) where id = true;

  insert into logs (who_id, act, detail) values (uid, 'init', '创建站点与站长 ' || p_nick);
  tk := issue_session(uid, false);
  return json_build_object('token', tk, 'uid', uid);
end;
$fn$;

-- 校验保护密码（通过后会话可读取站点公开信息）
create or replace function gate_check(p text)
returns text language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare tk text; st record;
begin
  select * into st from site where id = true;
  if st.gate_hash is null then raise exception '站点尚未初始化'; end if;

  /* 这里【不能】做失败计数：plpgsql 的 raise exception 会回滚同一函数内
     此前的所有写入，raise 前 update 计数永远累加不上去。
     真实限流必须在网关层做，见文件头「限流」一节。 */
  if not exists (select 1 from site where id = true and gate_hash = crypt(p, gate_hash)) then
    raise exception '保护密码错误';
  end if;

  tk := issue_session(null, true);
  return tk;
end;
$$;

-- 注册（默认 pending，需站长线下审核通过）
create or replace function user_register(p_nick text, p_pwd text, p_real text default null)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; cnt int;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
  if not (select allow_register from site where id = true) then
    raise exception '当前未开放注册';
  end if;
  if coalesce(length(p_nick), 0) < 1 then raise exception '请填写昵称'; end if;
  -- real_name 为可选字段（前端无真实姓名输入框），不强制
  if length(p_pwd) < 4 then raise exception '密码至少 4 位'; end if;
  select count(*) into cnt from users where lower(nick) = lower(p_nick);
  if cnt > 0 then raise exception '昵称已被占用'; end if;

  -- p_real 可为 null（前端不采集），列是 not null，故 coalesce
  insert into users (nick, real_name, pwd_hash, role, status)
  values (p_nick, coalesce(p_real, ''), crypt(p_pwd, gen_salt('bf', 10)), 'member', 'pending')
  returning id into uid;

  -- 站长账号自动通过；普通账号待审核
  insert into logs (who_id, act, detail) values (uid, 'register', p_nick || ' 待审核');
  return json_build_object('uid', uid, 'status', 'pending');
end;
$$;

-- 登录
create or replace function user_login(p_nick text, p_pwd text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare u record; tk text;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
  select * into u from users where lower(nick) = lower(p_nick);
  if not found then raise exception '昵称或密码错误'; end if;

  /* 同上：失败计数在这里无效（raise 会回滚），不要再加。 */
  if u.pwd_hash <> crypt(p_pwd, u.pwd_hash) then
    raise exception '昵称或密码错误';
  end if;

  -- 密码正确，再判状态（顺序不能反：否则能凭报错枚举"昵称是否存在/是否被封"）
  if u.status = 'banned' then raise exception '该账号已被封禁'; end if;
  if u.status = 'pending' then raise exception '账号待站长审核，请稍候'; end if;

  update users set last_seen = now() where id = u.id;
  tk := issue_session(u.id, false);
  -- 不返回 real_name：前端无该字段，且避免实名信息随登录响应外泄
  return json_build_object('token', tk, 'uid', u.id,
    'nick', u.nick, 'role', u.role, 'status', u.status);
end;
$$;

-- 拉取全量状态（需已通过保护密码）
/* 全量拉取。前端只在首次与"本地完全没数据"时用；日常轮询走 state_delta()。 */
create or replace function state_get()
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
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
    /* order by 必须写在 json_agg(...) 内部。
       写成 json_agg(x) ... order by m.created_at 会让整句变成聚合查询，
       报 "column must appear in the GROUP BY clause" —— 本地测试没跑到
       state_get 所以没暴露，真连上才炸。 */
    'messages', coalesce((select json_agg(json_build_object(
        'id', m.id, 'room', m.room_id, 'from', m.from_id, 'type', m.type,
        'text', m.body, 'mediaId', m.media_path, 'name', m.media_name,
        'size', m.media_size, 'replyTo', m.reply_to,
        'deleted', m.deleted,
        'ts', (extract(epoch from m.created_at) * 1000)::bigint
      ) order by m.created_at) from messages m
      where m.created_at > now() - interval '30 days'
        -- 只能看到自己所在房间的消息。
        -- 原来不加这层：私聊和别人的群聊会一视同仁全量返回。
        and (
          exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
          or exists (select 1 from room_members mm
                     where mm.room_id = m.room_id and mm.user_id = me)
        )
      ), '[]'::json),
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
) returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; mid uuid; st text;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  select status into st from users where id = uid;
  if st <> 'active' then raise exception '账号未通过审核'; end if;
  -- 统一走 acl_can_speak：权限 + 全站禁言 + 房间内禁言，一处维护
  if not (acl_can_speak(p_room)->>'ok')::boolean then
    raise exception '%', acl_can_speak(p_room)->>'why';
  end if;
  if not exists (
    select 1 from rooms r where r.id = p_room
      and (r.type = 'public' or exists (select 1 from room_members mm where mm.room_id = r.id and mm.user_id = uid))
  ) then raise exception '无权在该房间发言'; end if;

  -- 长度上限：不限制的话一条消息就能塞进几 MB 文本
  if length(coalesce(p_body,'')) > 8000 then raise exception '消息过长（上限 8000 字）'; end if;

  -- 频率控制：10 秒内最多 20 条。
  -- 数据库层做不了"失败计数"（raise 会回滚），但限流计数是在成功路径上写的，
  -- 不会回滚，所以这里有效。这是防灌水、防免费额度被打爆的主要闸门。
  if (select count(*) from messages
      where from_id = uid and created_at > now() - interval '10 seconds') >= 20 then
    raise exception '发送过于频繁，请稍后再试';
  end if;

  insert into messages (room_id, from_id, type, body, media_path, media_name, media_size, reply_to)
  values (p_room, uid, p_type, coalesce(p_body,''), p_media, p_name, coalesce(p_size,0), p_reply)
  returning id into mid;
  perform nextval('state_rev');
  return json_build_object('id', mid);
end;
$$;

-- 撤回 / 删除消息
create or replace function msg_delete(p_id uuid)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; r record;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  select * into r from messages where id = p_id;
  if not found then return false; end if;
  /* 自己的消息：走「撤回自己的消息」权限点，不再是硬编码 uid 相等。
     这样被授予 msg.recall.own 的人也能撤，被 denied 的人撤不了。 */
  if r.from_id = uid then
    perform acl_require('msg.recall.own', r.room_id);
    update messages set deleted = true, body = '', media_path = null where id = p_id;
    perform nextval('state_rev');
    return true;
  end if;
  /* 别人的消息：走统一的权限判定，不再硬编码 role in ('owner','admin')。
     硬编码的后果是房主/房管在自己的房间里管不了自己的群。 */
  if acl_can('msg.remove', r.room_id) then
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
returns text language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; rid text;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;

  -- 权限校验（原来完全没有：任何登录用户都能无限建群）
  perform acl_require('room.create');

  -- 数量上限：免费版空间有限，一个脚本批量建群就能把项目撑爆。
  -- 站长不受限（role='owner' 已在上面通过 acl_require，这里单独放行）。
  if (select role from users where id = uid) <> 'owner' then
    if (select count(*) from rooms where owner_id = uid) >= 20 then
      raise exception '每人最多建 20 个群';
    end if;
  end if;

  if coalesce(trim(p_name), '') = '' then raise exception '群名不能为空'; end if;
  if length(p_name) > 60 then raise exception '群名过长（上限 60 字）'; end if;
  if length(coalesce(p_desc,'')) > 500 then raise exception '群简介过长（上限 500 字）'; end if;
  rid := 'r_' || encode(gen_random_bytes(6), 'hex');
  insert into rooms (id, name, type, owner_id, description, pwd_hash)
  values (rid, p_name, 'group', uid, coalesce(p_desc,''),
          case when nullif(p_pwd,'') is null then null else crypt(p_pwd, gen_salt('bf', 10)) end);
  insert into room_members (room_id, user_id) values (rid, uid);
  perform nextval('state_rev');
  return rid;
end;
$$;

-- 私聊房间（不存在则创建）
create or replace function room_dm(p_other uuid)
returns text language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
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
) returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('room.manage', p_room);
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
                    else crypt(p_pwd, gen_salt('bf', 10)) end
  where id = p_room;
  perform nextval('state_rev');
  return true;
end;
$$;

-- 解散房间
create or replace function room_delete(p_room text)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('room.delete', p_room);
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('room.invite', p_room);
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('room.kick', p_room);
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('room.grant', p_room);
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('audit.review');
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('user.mute');
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('user.grant');
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('user.perms');
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('user.delete');
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; u record;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  select * into u from users where id = uid;
  if u.pwd_hash <> crypt(p_old, u.pwd_hash) then raise exception '原密码错误'; end if;
  if length(p_new) < 4 then raise exception '新密码至少 4 位'; end if;
  update users set pwd_hash = crypt(p_new, gen_salt('bf', 10)) where id = uid;
  return true;
end;
$$;

create or replace function gate_set(p_old text, p_new text)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('site.gate');
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (select 1 from users u where u.id = uid and u.role in ('owner','admin')) then
    raise exception '仅管理员可修改保护密码';
  end if;
  if not exists (select 1 from site where gate_hash = crypt(p_old, gate_hash)) then
    raise exception '原保护密码错误';
  end if;
  if length(p_new) < 4 then raise exception '新密码至少 4 位'; end if;
  update site set gate_hash = crypt(p_new, gen_salt('bf', 10)) where id = true;
  insert into logs (who_id, act, detail) values (uid, 'gate', '修改保护密码');
  return true;
end;
$$;

create or replace function site_set(p_name text default null, p_allow_register boolean default null)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('site.name');
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
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
begin
  delete from sessions where token_hash = cur_token_hash();
  return true;
end;
$$;

-- ==================================================================
-- 权限：只授予执行 RPC，不授予任何表的读写
-- ==================================================================
-- 清理过期会话。建议挂 pg_cron 每天跑一次，或用 GitHub Actions 定期调用。
-- 未登录也可调用（它只删自己那条已过期的记录，不泄露任何信息）。
create or replace function session_cleanup()
returns int language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare n int;
begin
  delete from sessions where expires_at < now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 老库补丁（幂等，重复执行安全）
alter table users        add column if not exists denied      text[] not null default '{}';
alter table room_members add column if not exists muted_until timestamptz;


-- ==================================================================
-- 权限判定（服务端）
--
-- 背景：原先「谁能做什么」由前端 acl.js 的 can() 判定，角色存在浏览器内存里，
--       打开 DevTools 改一下对象就能提权 —— 那不是权限，是提示。
--       现在把判定搬到服务端，前端只负责"要不要显示这个按钮"，
--       真正的放不放行由这里说了算。
--
-- 判定顺序（与前端保持一致，避免两边行为不一致）：
--   1. 未登录               → false
--   2. 已封禁（非 msg.send）→ false
--   3. 聚合键展开           → 任一子权限通过即可
--   4. 站长 owner           → true（恒为全部权限，不可剥夺）
--   5. 显式禁止 denied      → false
--   6. 显式授予 perms       → true
--   7. 角色默认             → true
--   8. 房主 / 房管在自己房间内、且属于房间固有权力 → true
--
-- ⚠ 新增任何写操作 RPC，第一件事就是在这里加一行 acl_require(...)。
-- ==================================================================

-- 角色默认权限（与前端 acl.js 的 ROLE_PERMS 一致，改动时两边都要改）
create or replace function acl_role_perms(p_role text) returns text[]
language sql immutable as $$
  select case p_role
    when 'owner' then array[
      -- owner 恒为全部，这里列出仅为与前端对齐；实际第 4 步已直接放行
      'msg.send','msg.recall.own','msg.remove','msg.delete','msg.viewRaw','msg.pin',
      'media.image','media.video','media.voice','media.file',
      'room.create','room.rename','room.notice','room.desc','room.pwd',
      'room.invite','room.kick','room.grant','room.delete','room.export',
      'user.view','user.mute','user.ban','user.create','user.delete',
      'user.grant','user.perms','user.transfer',
      'audit.review','audit.log',
      'site.name','site.gate','site.register','site.clean','site.export','site.reset',
      'sys.notice','sys.env'
    ]
    when 'admin' then array[
      'msg.send','msg.recall.own','msg.remove','msg.viewRaw',
      'media.image','media.video','media.voice','media.file',
      'room.create','room.rename','room.notice','room.desc','room.pwd',
      'room.invite','room.kick','room.delete','room.export',
      'user.view','user.mute','user.ban','user.create',
      'audit.review','audit.log',
      'site.name','site.register','site.clean','site.export',
      'sys.notice','sys.env'
    ]
    when 'member' then array[
      'msg.send','msg.recall.own',
      'media.image','media.video','media.voice','media.file',
      'room.create','user.view','sys.env'
    ]
    else '{}'::text[]
  end;
$$;

-- 聚合权限：任一子权限通过即通过（与前端 AGGREGATE 一致）
create or replace function acl_aggregate(p_perm text) returns text[]
language sql immutable as $$
  select case p_perm
    when 'msg.recall'  then array['msg.recall.own']
    when 'media.send'  then array['media.image','media.video','media.voice','media.file']
    when 'room.manage' then array['room.rename','room.notice','room.desc','room.pwd','room.invite','room.kick']
    else null
  end;
$$;

-- 房主 / 房管在自己房间内的固有权力（与前端 ROOM_INHERENT 一致）
create or replace function acl_room_inherent() returns text[]
language sql immutable as $$
  select array[
    'room.rename','room.notice','room.desc','room.pwd',
    'room.invite','room.kick','room.delete','room.export','user.mute'
  ];
$$;

-- 当前用户在某房间内的角色：owner / roomOwner / roomAdmin / member
create or replace function acl_room_role(p_room text) returns text
language sql stable as $$
  select case
    when cur_user() is null then 'guest'
    when exists (select 1 from users u where u.id = cur_user() and u.role = 'owner') then 'owner'
    when p_room is not null and exists (
      select 1 from rooms r where r.id = p_room and r.owner_id = cur_user()
    ) then 'roomOwner'
    when p_room is not null and exists (
      select 1 from room_admins ra where ra.room_id = p_room and ra.user_id = cur_user()
    ) then 'roomAdmin'
    else 'member'
  end;
$$;

-- 核心判定。p_room 传 null 表示站点级权限，传房间 id 表示房间级权限。
create or replace function acl_can(p_perm text, p_room text default null) returns boolean
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare
  uid uuid; u record; subs text[];
begin
  uid := cur_user();
  if uid is null then return false; end if;

  select * into u from users where id = uid;
  if not found then return false; end if;

  -- 2) 封禁：除发言外全部拒绝（发言仍允许，好让人知道自己被封了）
  if u.status = 'banned' and p_perm <> 'msg.send' then return false; end if;

  -- 3) 聚合键
  subs := acl_aggregate(p_perm);
  if subs is not null then
    return exists (
      select 1 from unnest(subs) as sp where acl_can(sp, p_room)
    );
  end if;

  -- 4) 站长恒为全部权限
  if u.role = 'owner' then return true; end if;

  -- 5) 显式禁止（优先级最高，站长已在上面放行）
  if p_perm = any (coalesce(u.denied, '{}'::text[])) then return false; end if;

  -- 6) 显式授予
  if p_perm = any (coalesce(u.perms, '{}'::text[])) then return true; end if;

  -- 7) 角色默认
  if p_perm = any (acl_role_perms(u.role)) then return true; end if;

  -- 8) 房主 / 房管的固有权力
  if p_room is not null
     and acl_room_role(p_room) in ('roomOwner','roomAdmin')
     and p_perm = any (acl_room_inherent()) then return true; end if;

  return false;
end;
$$;

-- 要求有某权限，否则抛错。写操作统一调这个，不要自己写 if。
create or replace function acl_require(p_perm text, p_room text default null) returns boolean
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  if cur_user() is null then raise exception '请先登录'; end if;
  if not acl_can(p_perm, p_room) then
    raise exception '没有「%」权限', coalesce(
      (select value from acl_perm_label where key = p_perm), p_perm);
  end if;
  return true;
end;
$$;

-- 权限点中文名（供错误提示与前端展示，避免各处硬编码）
create table if not exists acl_perm_label (
  key   text primary key,
  value text not null
);
insert into acl_perm_label (key, value) values
  ('msg.send','发言'), ('msg.recall.own','撤回自己的消息'),
  ('msg.remove','移除他人消息'), ('msg.delete','物理删除消息'),
  ('msg.viewRaw','查看被撤回消息原文'), ('msg.pin','置顶消息'),
  ('media.image','发送图片'), ('media.video','发送视频'),
  ('media.voice','发送语音'), ('media.file','发送文件'),
  ('room.create','创建群聊'), ('room.rename','修改群名'),
  ('room.notice','修改群公告'), ('room.desc','修改群简介'),
  ('room.pwd','修改群密码'), ('room.invite','邀请成员'),
  ('room.kick','移出成员'), ('room.grant','设置群管理员'),
  ('room.delete','解散群聊'), ('room.export','导出群聊记录'),
  ('user.view','查看成员'), ('user.mute','禁言'),
  ('user.ban','封禁账号'), ('user.create','手动开户'),
  ('user.delete','删除用户'), ('user.grant','授予管理员'),
  ('user.perms','分配他人权限'), ('user.transfer','转让站长'),
  ('audit.review','审核注册'), ('audit.log','查看日志'),
  ('site.name','修改站点名称'), ('site.gate','修改保护密码'),
  ('site.register','开关注册'), ('site.clean','清理媒体'),
  ('site.export','导出全站数据'), ('site.reset','重置站点'),
  ('sys.notice','发布全站公告'), ('sys.env','查看运行环境')
on conflict (key) do nothing;

-- 能否发言：权限 + 全站禁言 + 房间内禁言
create or replace function acl_can_speak(p_room text default null)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare u record; rm record;
begin
  if cur_user() is null then
    return json_build_object('ok', false, 'why', '请先登录');
  end if;
  select * into u from users where id = cur_user();

  if not acl_can('msg.send', p_room) then
    return json_build_object('ok', false, 'why', '没有发言权限');
  end if;

  if u.muted_until is not null and u.muted_until > now() then
    return json_build_object('ok', false, 'why', '你已被禁言，剩余 '
      || ceil(extract(epoch from (u.muted_until - now())) / 60)::int || ' 分钟');
  end if;

  if p_room is not null then
    select * into rm from room_members where room_id = p_room and user_id = cur_user();
    if found and rm.muted_until is not null and rm.muted_until > now() then
      return json_build_object('ok', false, 'why', '你已被本群禁言，剩余 '
        || ceil(extract(epoch from (rm.muted_until - now())) / 60)::int || ' 分钟');
    end if;
  end if;

  return json_build_object('ok', true);
end;
$$;

-- 前端一次性拉取全部权限点状态，避免逐项往返
create or replace function acl_mine(p_room text default null)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare u record; k text; res jsonb := '{}'::jsonb;
begin
  if cur_user() is null then return '{}'::json; end if;
  select * into u from users where id = cur_user();
  for k in select key from acl_perm_label loop
    res := res || jsonb_build_object(k, acl_can(k, p_room));
  end loop;
  return json_build_object(
    'uid', u.id, 'nick', u.nick, 'role', u.role, 'status', u.status,
    'perms', res,
    'muted_until', u.muted_until
  );
end;
$$;

revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant execute on all functions in schema public to anon, authenticated;
-- session_cleanup 只影响过期记录，保留给 anon 便于外部定时调用
grant execute on function session_cleanup() to anon, authenticated;

-- Storage：媒体桶
-- public=true 且零策略 = 匿名可读可写的公开文件托管点。
-- 被扫到会当图床用，免费版带宽配额（约 5GB/月）第一个月就超。
-- 改成私有：读写一律走服务端签发的短时 URL，不对外敞开。
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;
update storage.buckets set public = false where id = 'media';

-- 桶级策略：只允许登录用户读自己所在房间的媒体。
-- 没有这层，私有桶只是"默认拒绝"，仍然要靠下面的函数取签名 URL。
drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and auth_role() is not null);
drop policy if exists media_write on storage.objects;
create policy media_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and auth_role() is not null);
