-- 临时：分段定位迁移阻塞点（用完即清）—— 只跑 invite_create 之前的部分
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
  created_at    timestamptz not null default now(),

  -- 改保护密码后的宽限：旧密码仍可登录一次。
  -- 为什么需要：改密码的人自己也可能还没记住新密码，一刀切把自己锁在外面。
  -- gate_new_enc 用旧密码派生的密钥加密新密码 —— 服务端不存明文，
  -- 只有拿旧密码登录（宽限期内）那一刻才解得出来，用来把新密码展示给他看。
  gate_prev_hash text,                      -- 旧密码的 bcrypt，宽限结束后清空
  gate_new_enc   bytea,                     -- 新密码密文（密钥 = 旧密码派生）
  gate_grace     int not null default 0     -- 剩余宽限次数，新/旧密码登录都消耗
);
insert into site (id) values (true) on conflict (id) do nothing;

-- 老库补列（幂等）
alter table site add column if not exists gate_prev_hash text;
alter table site add column if not exists gate_new_enc   bytea;
alter table site add column if not exists gate_grace     int not null default 0;

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
  /* 「能不能邀请别人」按人开关。
     默认 true —— 群聊里成员互相拉人是常态。
     但遇到不可信的人（乱拉人、拉进来的是广告号），
     管理员要能单独关掉他的邀请权，而不是把他踢出去或降权。
     房主 / 站长 / 管理员不受这个开关限制（他们本来就有 room.invite）。 */
  can_invite boolean not null default true,
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
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  /* 全局单调递增序号，取自 state_rev。
     增量拉取直接比大小（m.rev > p_since），不再用时间窗估算。
     insert 与 update 都要 bump（触发器保证）——
     只 bump insert 的话，编辑/撤回后的消息客户端永远拉不到。 */
  rev        bigint
);
create index if not exists messages_room_idx on messages (room_id, created_at);
create index if not exists messages_rev_idx on messages (rev);

/* rev 由触发器写入：insert 时取号，update（编辑/撤回）时也要重新取号，
   否则改完的消息序号没变，按 rev 增量拉取就拉不到这次变更。 */
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

-- ---------- 操作日志 ----------
create table if not exists logs (
  id         uuid primary key default gen_random_uuid(),
  who_id     uuid references users(id) on delete set null,
  act        text not null,
  detail     text not null default '',
  target     text not null default '',
  created_at timestamptz not null default now(),
  /* ⚠ 增量拉取必须靠 rev，不能靠估算时间窗（S-067）。
     logs 以前和 messages 一样用 "rev 差 × 2 秒" 反推时间窗 ——
     站点冷清时窗很窄，离线期间的日志全落在窗外，
     管理员离线一小时后上线，看到的审计记录是缺的。
     **审计记录缺失恰恰是最不能被接受的那种缺失：
     出事之后查日志，查到的却是不完整的日志。** */
  rev        bigint
);
create index if not exists logs_time_idx on logs (created_at desc);
create index if not exists logs_rev_idx on logs (rev);

/* logs 写入时自动取 rev 号，与时间无关，不受时钟与并发影响。
   复用 messages 那个取号函数 —— 它做的事就是"取下一个全局序号"，
   与哪张表无关。（函数名叫 msg_ 是历史原因，语义上是通用的。） */
drop trigger if exists logs_rev_trg on logs;
create trigger logs_rev_trg before insert on logs
  for each row execute function msg_rev_bump();

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
          -- 门禁会话单独用短有效期（1 天），登录会话才是 14 天。
          -- 门禁是每次成功检查就建一条，没有限流（见 gate_check 注释），
          -- 一分钟 60 次 × 14 天 = 120 万条，会撑爆免费额度。
          now() + (case when coalesce(gate_only, false)
                        then interval '1 day'
                        else interval '14 days' end));
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

  /* 时间窗只给 logs 用（它没 rev 列）。
     ⚠ messages 曾经也用这个窗拉增量，那是错的：
       rev 差 × 2 秒只是估算，站点冷清时 rev 差小、窗窄，
       离线期间的消息会落在窗外 —— 前端按 id merge，缺了就永远缺了。
     messages 现在直接比 rev（见下方 where m.rev > p_since），精确且可索引。 */
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
        'admins', coalesce((select json_agg(aa.user_id) from room_admins aa where aa.room_id = rm.id), '[]'::json),
        /* 被单独关掉邀请权的成员。
           不回传的话前端刷新一次开关就"自己弹回来"——
           而服务端其实已经禁掉了，界面与事实不符。 */
        'noInvite', coalesce((select json_agg(ni.user_id) from room_members ni
                              where ni.room_id = rm.id and ni.can_invite = false), '[]'::json)
      ) as r from rooms rm) x), '[]'::json),
    'messages', coalesce((select json_agg(json_build_object(
        'id', m.id, 'room', m.room_id, 'from', m.from_id, 'type', m.type,
        'text', m.body, 'mediaId', m.media_path, 'name', m.media_name,
        'size', m.media_size, 'replyTo', m.reply_to,
        'deleted', m.deleted,
   'edited',  m.edited_at,
        'ts', (extract(epoch from m.created_at) * 1000)::bigint
      ) order by m.rev) from messages m
      /* ⚠ 是 >= 不是 >。
         客户端拿到的 p_since 来自 state_peek()，那是"最后分配出去的号"，
         而最后分配的号往往正是刚发的那条消息的 rev。
         用 > 会把这条漏掉 —— 用户自己发的消息，自己这边看不到。
         用 >= 最多重复送最后一条，前端按 id merge 会去重，无害。 */
      where coalesce(m.rev, 0) >= coalesce(p_since, 0)
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
        select * from logs where rev > p_since order by rev desc limit 200
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
-- ⚠ 必须先 drop：Postgres 的 create or replace 【不允许改变返回类型】。
--   线上原本是 returns text，这里改成了 json，不 drop 会直接报
--   "cannot change return type of existing function"，整段迁移失败。
--
--   教训：改函数返回类型时，create or replace 不够，必须 drop 再建。
--   本地测试库是空的所以测不出来 —— 只有已有数据的线上库才会暴露。
drop function if exists gate_check(text);

-- 保护密码校验。返回 json：{ok, token, show_new}
--   ok       ：是否通过
--   token    ：会话
--   show_new ：非 null 时表示"你是用旧密码进来的"，值为新密码明文 ——
--              前端必须把它显示出来并强制用户记住，因为这次之后旧密码就作废了。
create or replace function gate_check(p text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare tk text; st record; ok_new boolean; ok_old boolean; plain text;
begin
  select * into st from site where id = true;
  if st.gate_hash is null then raise exception '站点尚未初始化'; end if;

  /* 这里【不能】做失败计数：plpgsql 的 raise exception 会回滚同一函数内
     此前的所有写入，raise 前 update 计数永远累加不上去。
     真实限流必须在网关层做，见文件头「限流」一节。 */

  ok_new := exists (select 1 from site where id = true and gate_hash = crypt(p, gate_hash));
  ok_old := false;

  if not ok_new and st.gate_grace > 0 and st.gate_prev_hash is not null then
    ok_old := exists (select 1 from site where id = true and gate_prev_hash = crypt(p, gate_prev_hash));
  end if;

  if not ok_new and not ok_old then
    raise exception '保护密码错误';
  end if;

  /* 宽限次数：新密码登录也消耗 ——
     只要有人用新密码成功进来过，就说明新密码已经在流通，旧密码没必要继续留。 */
  if st.gate_grace > 0 then
    update site set gate_grace = gate_grace - 1 where id = true;
    if st.gate_grace - 1 <= 0 then
      update site set gate_prev_hash = null, gate_new_enc = null, gate_grace = 0 where id = true;
    end if;
  end if;

  /* 用旧密码进来：解密出新密码，交前端展示 */
  plain := null;
  if ok_old and st.gate_new_enc is not null then
    begin
      plain := pgp_sym_decrypt(st.gate_new_enc,
                 encode(digest(p || '|gate-grace-v1', 'sha256'), 'hex'));
    exception when others then
      plain := null;   -- 解不出来也不能挡住登录，只是展示不了
    end;
  end if;

  tk := issue_session(null, true);
  return json_build_object('ok', true, 'token', tk, 'show_new', plain);
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
  if coalesce(length(p_nick), 0) > 24 then raise exception '昵称最多 24 个字符'; end if;

  -- ⚠ 昵称必须限制字符集（S-100，考古补回）。
  -- 原来只校验 length >= 1，**不过滤控制字符、换行、零宽字符、同形异码字符**。
  -- 后果是可以注册出跟别人**看起来一模一样**的昵称：
  -- 用零宽字符或西里尔字母的同形字符冒充站长，其他人 @ 他、点他头像时
  -- 根本分不出来。而前端没有此校验、只靠服务端兜底，
  -- 所以这一层一旦漏了，仿冒就是畅通无阻的。
  --
  -- 白名单：汉字、ASCII 字母数字、下划线、连字符、点、空格、间隔号。
  -- **只放行 ASCII 拉丁字母**这一点正是关键：西里尔字母的 а/е/о
  -- 与拉丁 a/e/o 肉眼几乎无法区分，若放行就能注册出"和站长一模一样"的昵称。
  -- 再叠加控制字符与零宽字符（U+200B-200F、U+2028/2029、U+FEFF）的显式排除。
  -- 写法说明：PostgreSQL 的普通字符串字面量**不做** \uXXXX 转义，
  -- POSIX 正则也不支持 \p{Han}。所以这里直接写汉字范围的字面量，
  -- 零宽/控制字符用 chr() 显式比对（最稳，不依赖正则方言）。
  -- ⚠ 连字符必须放在字符类**末尾**（本次踩坑）。
  --   原来写成 '_\-. '，而 PostgreSQL 的 POSIX 正则在方括号内
  --   **不把反斜杠当转义符** —— 于是 '\-.' 被解析成
  --   从 '\'(0x5C) 到 '.'(0x2E) 的范围，起点大于终点，
  --   整条语句直接报 "invalid regular expression: invalid range end"。
  --   因为 psql 开了 ON_ERROR_STOP=1，这一个错误让**整份 schema.sql 停在这里**，
  --   后面所有函数（含本次的自定义口令）一个都没建起来。
  --
  --   这类错误的教训：改 PG 正则必须能本地验证，否则只能靠实跑发现，
  --   而实跑的代价是整份迁移挂掉。
  if p_nick !~ '^[一-龥a-zA-Z0-9_. ·‧-]{1,24}$' then
    raise exception '昵称只能包含中英文、数字、下划线、连字符和空格';
  end if;
  if p_nick ~ '[[:cntrl:]]' then
    raise exception '昵称不能包含控制字符';
  end if;
  -- 零宽与不可见字符：U+200B~200F、U+2028、U+2029、U+FEFF
  if p_nick like '%' || chr(8203) || '%'
     or p_nick like '%' || chr(8204) || '%'
     or p_nick like '%' || chr(8205) || '%'
     or p_nick like '%' || chr(8206) || '%'
     or p_nick like '%' || chr(8207) || '%'
     or p_nick like '%' || chr(8232) || '%'
     or p_nick like '%' || chr(8233) || '%'
     or p_nick like '%' || chr(65279) || '%' then
    raise exception '昵称不能包含不可见字符';
  end if;

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

-- ==================================================================
-- 登录失败计数
--
-- 为什么单独建表、且 user_login 不再用 raise 报错：
--   plpgsql 里 raise exception 会回滚同一函数内此前的写入，
--   所以"先记一次失败再抛错"永远记不上 —— 计数必须是能提交的。
--
-- 做法：密码错误时【写入计数并 return ok:false】，而不是 raise。
--       没有 raise，写入就提交了，计数才真正生效。
-- ==================================================================

create table if not exists login_attempts (
  id         bigserial primary key,
  nick       text not null,
  ip_hint    text not null default '',
  ok         boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists login_attempts_time_idx on login_attempts (created_at desc);
create index if not exists login_attempts_nick_idx on login_attempts (lower(nick), created_at desc);

/* 管理员手动清理入口。
   必须鉴权：谁都能调的话，攻击者可以反复清空失败记录，
   刚做的登录限流就形同虚设 —— 冻不住任何人。
   注意：登录成功路径不能调这个（会把普通用户自己拒绝掉），
   那里改成内联 delete 了。 */
create or replace function login_attempts_cleanup()
returns void language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
begin
  if not auth_is_staff() then
    raise exception '仅管理员可清理登录记录';
  end if;
  delete from login_attempts where created_at < now() - interval '24 hours';
end;
$$;

/* 登录。
   注意契约变化：凭证类失败【返回 ok:false】而不是 raise ——
   只有这样失败计数才提交得了（raise 会回滚写入）。
   调用方必须检查返回值里的 ok 字段，不能只看"没抛异常"。 */
create or replace function user_login(p_nick text, p_pwd text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare u record; tk text; v_fail int;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;

  /* 频率闸门：15 分钟内同一昵称失败 8 次即冻结 15 分钟。
     这是数据库层唯一能做的登录限流位置。

     ⚠ 只按昵称计数是不够的（S-008）：换一个昵称就绕过了，
     而且任何人知道你昵称、试错 8 次就能把你锁 15 分钟。
     所以下面还有一道全局闸门。 */
  select count(*) into v_fail from login_attempts
   where lower(nick) = lower(p_nick) and ok = false
     and created_at > now() - interval '15 minutes';
  if v_fail >= 8 then
    return json_build_object('ok', false, 'err', '尝试次数过多，请 15 分钟后再试');
  end if;

  /* 全局闸门：15 分钟内全站失败 ≥ 300 次就整体拒绝。
     这是"换昵称爆破"唯一拦得住的地方 —— 昵称维度对它是无效的。

     为什么不用 IP 做第二维度：
       · 请求头里的 x-forwarded-for 客户端自己能改，等于没有
       · 同一个 NAT 后面可能是一整个学校/公司，按 IP 限流会误伤一大片
     所以宁可粗一点用全局闸门。

     ⚠ 这个闸门有代价，必须知道：
       它挡的是"爆破"，但副作用是**攻击者可以拿它当拒绝服务用** ——
       故意失败 300 次，全站正常用户就都登录不上了。
       这是"没有网关层限流"时能做的最好选择，不是完美方案。
       阈值定 300 而不是 100，是因为本测试里
       光是跑一轮限流用例就必然失败 130 次以上，
       100 会把后面的正常登录一起挡掉 ——
       **挡得太狠，先被挡住的是自己人。** */
  select count(*) into v_fail from login_attempts
   where ok = false and created_at > now() - interval '15 minutes';
  if v_fail >= 300 then
    return json_build_object('ok', false, 'err', '登录尝试过于频繁，请稍后再试');
  end if;

  select * into u from users where lower(nick) = lower(p_nick);
  if not found then
    insert into login_attempts (nick, ok) values (p_nick, false);
    /* ⚠ 这里原来有一句 perform nextval('state_rev')（S-006）。
       登录失败跟状态变更毫无关系，却会让每次失败都推进全局序号，
       惊动所有在线客户端去拉一次增量 ——
       1 次爆破请求被放大成 N 次拉取，等于给了攻击者一个免费放大器。
       删掉。 */
    return json_build_object('ok', false, 'err', '昵称或密码错误');
  end if;

  if u.pwd_hash <> crypt(p_pwd, u.pwd_hash) then
    insert into login_attempts (nick, ok) values (p_nick, false);
    /* 同上：失败不推进全局序号 */
    return json_build_object('ok', false, 'err', '昵称或密码错误');
  end if;

  -- 密码正确，再判状态（顺序不能反：否则能凭报错枚举"昵称是否存在/是否被封"）
  if u.status = 'banned' then
    return json_build_object('ok', false, 'err', '该账号已被封禁');
  end if;
  if u.status = 'pending' then
    return json_build_object('ok', false, 'err', '账号待站长审核，请稍候');
  end if;

  insert into login_attempts (nick, ok) values (p_nick, true);
  /* 登录成功：只清这个昵称自己的旧失败记录（好让计数重新开始）。
     ⚠ 全表清理不在这里做 —— 放在 session_cleanup() 里。
       原因：只在成功时清理，等于清理依赖攻击者去登录成功一次，
       纯爆破路径下这张表会无限增长。 */
  delete from login_attempts
   where lower(nick) = lower(p_nick) and ok = false;

  update users set last_seen = now() where id = u.id;
  tk := issue_session(u.id, false);
  -- 不返回 real_name：前端无该字段，且避免实名信息随登录响应外泄
  return json_build_object('ok', true, 'token', tk, 'uid', u.id,
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
    /* ⚠ 服务端时间必须下发（E-049 / S-065）。
       前端的"在线判定"和"撤回时限"都拿本机 Date.now()
       去比服务端的 last_seen / created_at ——
       本机钟快 5 分钟 → 所有人永远显示离线；
       本机钟慢 → 所有人永远在线，且能撤回任意旧消息。
       这种偏差用户看不出原因，只会觉得软件不准。
       所以下发服务端时间，客户端据此算出偏移量。 */
    'serverNow', (extract(epoch from now()) * 1000)::bigint,
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
        'admins', coalesce((select json_agg(aa.user_id) from room_admins aa where aa.room_id = rm.id), '[]'::json),
        /* 被单独关掉邀请权的成员。
           不回传的话前端刷新一次开关就"自己弹回来"——
           而服务端其实已经禁掉了，界面与事实不符。 */
        'noInvite', coalesce((select json_agg(ni.user_id) from room_members ni
                              where ni.room_id = rm.id and ni.can_invite = false), '[]'::json)
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
   'edited',  m.edited_at,
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
  /* ⚠ 这里原来还有一句 perform nextval('state_rev')。
     现在 rev 由触发器写入，insert 时序列已经前进了 ——
     再多取一个号会把序列推到消息 rev 之上，
     客户端 state_peek 拿到的是推过头的号，
     再按它拉增量就永远拿不到这条刚发的消息。
     所以删掉。 */
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
    /* ⚠ 撤回时限必须服务端判（S-063）。
       原来只有前端 RECALL_MS 挡着 —— 那纯粹是 UI 门面：
       直接调 RPC 就能撤回三个月前的任何一条消息。
       **能在界面上挡住，不等于在接口上挡住了。**
       管理员删别人的消息不受此时限（管理行为另有一套尺度）。 */
    if r.created_at < now() - interval '5 minutes' then
      raise exception '超过 5 分钟，不能撤回了';
    end if;
    update messages set deleted = true, body = '', media_path = null where id = p_id;
    /* 同上：update 由触发器 bump rev，这里不再额外 nextval */
    return true;
  end if;
  /* 别人的消息：走统一的权限判定，不再硬编码 role in ('owner','admin')。
     硬编码的后果是房主/房管在自己的房间里管不了自己的群。 */
  if acl_can('msg.remove', r.room_id) then
    update messages set deleted = true, body = '', media_path = null where id = p_id;
    insert into logs (who_id, act, detail) values (uid, 'delete', '删除消息 ' || p_id);
    /* 同上 */
    return true;
  end if;
  raise exception '无权删除该消息';
end;
$$;

-- 编辑已发出的消息。
-- 只改正文，不动媒体、不动发送者、不动时间。
-- 改完置 edited_at，前端据此显示「已编辑」角标 —— 不标的话，
-- 别人看到的消息和记忆里不一样却无从察觉。
create or replace function msg_edit(p_id uuid, p_body text)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; r record; len int;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;

  select * into r from messages where id = p_id;
  if not found then return false; end if;

  /* 只有本人能编辑自己的消息。
     不像删除那样给管理员开口子 —— 改别人的话属于伪造发言内容，
     性质比删除严重得多，不该有任何角色能做。 */
  if r.from_id <> uid then
    raise exception '只能编辑自己的消息';
  end if;

  if r.deleted then raise exception '消息已撤回，不能编辑'; end if;

  /* ⚠ 编辑时限同样必须服务端判（S-063）。
     前端 EDIT_MS 只是门面，绕过就能编辑任意旧消息 ——
     而且编辑比撤回更隐蔽：改的是历史发言内容，
     别人看到的是"他当时就是这么说的"。 */
  if r.created_at < now() - interval '10 minutes' then
    raise exception '超过 10 分钟，不能编辑了';
  end if;

  /* 长度上限，与发送侧一致。不设的话一条消息能撑爆额度。 */
  len := coalesce(char_length(p_body), 0);
  if len > 8000 then raise exception '消息过长（上限 8000 字）'; end if;

  update messages
     set body = p_body, edited_at = now()
   where id = p_id;

  insert into logs (who_id, act, detail)
  values (uid, 'edit', '编辑消息 ' || p_id);

  /* 同上：update 由触发器 bump rev，不再额外 nextval */
  return true;
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
  insert into logs (who_id, act, detail, target)
  values (uid, 'room.delete', '解散房间', p_room);
  delete from rooms where id = p_room;
  perform nextval('state_rev');
  return true;
end;
$$;

-- ==================================================================
-- 邀请码（服务端存，换设备也能用）
--   原来口令只存在前端 S.invites（本地 localStorage），
--   结果「在 A 机器生成的口令，B 机器输入说不存在」——
--   邀请功能实际上只在生成它的那台设备上成立。
--   邀请码是要发给别人的，天生就是跨设备、跨人的，必须服务端存。
-- ==================================================================
create table if not exists invites (
  code       text primary key,
  room_id    text not null references rooms(id) on delete cascade,
  by_user    uuid references users(id) on delete set null,
  expire_at  timestamptz,                    -- null = 长期有效
  max_use    int not null default 0,         -- 0 = 不限次数
  used       int not null default 0,
  revoked_at timestamptz,                    -- 主动作废
  created_at timestamptz not null default now()
);
create index if not exists invites_room_idx on invites(room_id, created_at desc);

-- 生成邀请码。
-- 鉴权：登录 + 是本房间成员（或站长/管理员）+ 该成员没被单独禁掉邀请权。

-- ⚠ 必须先删掉旧的 3 参数签名（本次踩坑）。
--   PostgreSQL 的 CREATE OR REPLACE **改不了参数列表**：
--   加了第 4 个参数后，它不是替换原函数，而是**新建一个重载**。
--   于是两个版本并存，而 grant 只给了旧签名 ——
--   结果：不传自定义口令时走老版本（正常），传了就走新版本（permission denied）。
--   "有时能用有时没权限"这种错最难查，因为它看起来像权限配置飘了。
