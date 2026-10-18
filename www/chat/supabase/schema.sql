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
/* 无门模式（用户主动取消站点保护密码）。
   ⚠ 必须是一个独立的布尔列，不能用 "gate_hash is null" 代替 ——
      gate_hash 为空同时表示"站点尚未初始化"，两者语义相反：
        未初始化 → 任何人都能调 site_init 建站长（危险）
        无门     → 站点已建好，只是不再设门禁（正常开放）
      混用一个字段，就会在取消密码的瞬间把站点退回"可被人抢注站长"的状态。
   账号验证仍在：绝大多数 RPC 要求 cur_user() 非空（登录），
   gate_passed 只是"能否读取公开信息"这一层，不是身份。 */
alter table site add column if not exists gate_disabled boolean not null default false;
alter table site add column if not exists gate_new_enc   bytea;
alter table site add column if not exists gate_grace     int not null default 0;

-- ---------- 用户 ----------
/* ⚠⚠ Q-Chat-S-130：加列必须用 alter，不能用 create table if not exists。
   `create table if not exists` 对**已存在的表完全跳过** ——
   写在建表语句里的新列永远不会生效，而迁移不报错，看着像成功了。

   第一次踩：site_perms 加 scope 列（S-125），insert 报 column 不存在才发现。
   第二次踩：users 加 avatar 列（S-123）。这次更隐蔽 ——
   state_delta() 引用 u.avatar，**列不存在 → 每次同步调用直接抛异常**，
   等于实时同步从 S-123 起整条是坏的，而我当时只验了 profile_update，
   没验"引用到该列的其他函数"。

   ⚠ 教训：改 schema 后要验**引用该列的每个函数**，不是只验新增的那个。 */
alter table users add column if not exists avatar text;

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
  last_seen   timestamptz not null default now(),
  /* ⚠ avatar 必须存服务端（Q-Chat-S-123）：
     原来头像只存在本地媒体库（me.avatarId），**换设备就没了**，
     而且账号升到集群层后，在主页设的头像聊天室里看不到 ——
     两个页面显示两个头像，"统一账号"就是假的。
     这里只存 media id / URL，不存 base64（会让 users 表膨胀，
     且每次 state_get 都把整张图拖回来）。 */
  avatar      text,
  /* ⚠ rev 是**真正的"资料版本"**（S-085，考古补回）。
     原来前端把 last_seen 当成 updatedAt 用 —— 那是"最后上线时间"，
     不是"资料最后修改时间"。两者混用的后果见 state_delta 处的注释。
     沿用项目既有的全局单调序号（与 messages 一致）。 */
  rev         bigint
);
create index if not exists users_nick_idx on users (lower(nick));
/* ⚠ create table if not exists 对**已存在的表整段跳过**（SCHEMA-ALTER），
   后加的列永远加不上 —— 线上实测就是这样缺列的。必须显式 alter。 */
alter table users add column if not exists rev bigint;
create index if not exists users_rev_idx on users (rev);

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
  created_at timestamptz not null default now(),
  /* ⚠ 上一行末尾的逗号：我第一版漏了，迁移直接 syntax error。
     建表语句里最后一列后面必须跟逗号才能接新列 —— 但**更根本的问题**
     是 create table if not exists 对已存在的表整段跳过，
     所以真正生效的是下面那句 alter，不是这里的声明。两处都要对。 */
  rev         bigint
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

/* ⚠ users / rooms 也要 bump rev（S-085）。
   只给 messages 建触发器是不够的 —— 用户资料、房间名/公告的变更
   同样要能被增量拉取感知到，否则前端按 rev 比大小时拿不到这些变更。
   msg_rev_bump 本身是通用的（就是取一个全局号），直接复用。 */
drop trigger if exists users_rev_bi on users;
create trigger users_rev_bi before insert on users
  for each row execute function msg_rev_bump();

drop trigger if exists users_rev_bu on users;
create trigger users_rev_bu before update on users
  for each row execute function msg_rev_bump();

drop trigger if exists rooms_rev_bi on rooms;
create trigger rooms_rev_bi before insert on rooms
  for each row execute function msg_rev_bump();

drop trigger if exists rooms_rev_bu on rooms;
create trigger rooms_rev_bu before update on rooms
  for each row execute function msg_rev_bump();

-- ---------- 操作日志 ----------
alter table rooms add column if not exists rev bigint;
create index if not exists rooms_rev_idx on rooms (rev);

/* ⚠ 回填老数据的 rev（S-085）—— 这一步不做，前面全白做。
   触发器只管**新建和更新**，加列之前就存在的行 rev 全是 null。
   而前端判新旧用的是 `x.rev > o.rev`：
     null > null  → false  → **合并分支依然不执行**
   等于改了个寂寞，且这次的"寂寞"比原来更难发现 ——
   因为列也在、触发器也在，看代码以为修好了。

   幂等：只回填 rev is null 的行，重复跑不会把已有号冲掉。
   注意：update 会触发上面的 bu 触发器再取一个号，
   最终 rev 是触发器给的那个 —— 无所谓，只要非 null 且与全局水位同步前进。 */
update users set rev = nextval('state_rev') where rev is null;
update rooms set rev = nextval('state_rev') where rev is null;

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

/* ⚠ 补列（SCHEMA-ALTER）：create table 用的是 if not exists，
   **已存在的表会被整段跳过** —— 于是表定义里后加的列永远加不上。
   线上实测就是这个状态：messages 没有 edited_at、logs 没有 rev，
   而后面的 create index ... on logs(rev) 直接报 column does not exist，
   psql 开了 ON_ERROR_STOP=1，整份迁移就停在那一行，后面全没建。

   所以凡是"后来往已有表里加的列"，都必须在这里显式 alter 补一次。 */
alter table messages add column if not exists edited_at timestamptz;
alter table logs      add column if not exists rev bigint;

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
  /* 无门模式：直接放行（Q-Chat-S-120）。
     ⚠ 这里"放行"的含义很窄 —— 只是允许读取站点公开信息
       （site_ready / state_get / user_register 等少数几个）。
       绝大多数写操作仍要求 cur_user() 非空，也就是**必须登录账号**。
       所以取消保护密码 ≠ 公开站点内容，账号这道门还在原处。 */
  select coalesce((select gate_disabled from site where id = true), false)
      or exists (
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
  -- ⚠ 无门模式下 gate_hash 被清空，但站点确实是"已初始化"的。
  --   不加这个 or，前端会误判成未初始化、弹出"创建站点"页 ——
  --   那等于把已建好的站点当成空站，风险极大。
  select exists (select 1 from site where gate_hash is not null or gate_disabled);
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
  /* ★ 同 state_get（Q-Chat-S-130 / 外部报告 C-3）：增量接口同样要查登录。
     ⚠ 只堵 state_get 等于没堵 —— 绕过它直接调 state_delta
     能拿到完全一样的东西。两个口子必须一起堵。 */
  if me is null then raise exception '请先登录'; end if;
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
      select site_name, allow_register, (gate_hash is not null) as has_gate,
             -- Q-Chat-S-120：无门模式。前端据此跳过密码框。
             coalesce(gate_disabled, false) as gate_off from site where id = true) s),
    /* 用户与房间量小且变动会牵动权限，每次都带上，不做增量 */
    'users', coalesce((select json_agg(json_build_object(
        'id', u.id, 'nick', u.nick, 'realName', u.real_name, 'role', u.role,
        'status', u.status, 'perms', u.perms, 'bio', u.bio,
        'mutedUntil', (extract(epoch from u.muted_until) * 1000)::bigint,
        'createdAt', (extract(epoch from u.created_at) * 1000)::bigint,
        'lastSeen', (extract(epoch from u.last_seen) * 1000)::bigint,
        /* ⚠ rev 必须回传（S-085）。
           不回传的话前端只能拿 lastSeen 顶替"资料版本"，
           于是**每次上线都算一次"资料变更"**，合并判据彻底失真。 */
        'rev', u.rev,
        'avatar', u.avatar
      )) from users u), '[]'::json),
    'rooms', coalesce((select json_agg(r) from (
      select json_build_object(
        'id', rm.id, 'name', rm.name, 'type', rm.type, 'owner', rm.owner_id,
        'desc', rm.description, 'notice', rm.notice,
        'hasPwd', (rm.pwd_hash is not null),
        'createdAt', (extract(epoch from rm.created_at) * 1000)::bigint,
        /* ⚠ rev 必须回传（S-085，这条最要紧）。
           rooms 表**根本没有 updated_at 列**，前端 tRoom 只能拿
           created_at 顶替 —— 而 created_at 永远不变。
           于是 mergeArr 的 `x.updatedAt > o.updatedAt` 恒为 false，
           **房间资料的合并分支永远不执行**：
           服务端改了房间名/公告，前端同步回来时被整个丢弃。
           这正是"公告改了不同步""置顶只改本地"那一族问题的共同根因。 */
        'rev', rm.rev,
        'members', coalesce((select json_agg(mm.user_id) from room_members mm where mm.room_id = rm.id), '[]'::json),
        'admins', coalesce((select json_agg(aa.user_id) from room_admins aa where aa.room_id = rm.id), '[]'::json),
        /* 被单独关掉邀请权的成员。
           不回传的话前端刷新一次开关就"自己弹回来"——
           而服务端其实已经禁掉了，界面与事实不符。 */
        'noInvite', coalesce((select json_agg(ni.user_id) from room_members ni
                              where ni.room_id = rm.id and ni.can_invite = false), '[]'::json),
        /* ⚠ 群内禁言必须回传（S-113）。
           不回传的话前端只能继续用本地 room.muted 数组 ——
           而数组改的是本地、换设备就没、被禁者自己改一下就解了，
           **服务端根本不知道有过这次禁言**。
           这里回传"仍在生效"的禁言：user_id → 到期时间戳（毫秒）。
           已过期的不再回传（前端据此自动解禁，不用等定时器）。 */
        'roomMuted', coalesce((select json_object_agg(
            mu.user_id,
            (extract(epoch from mu.muted_until) * 1000)::bigint)
          from room_members mu
          where mu.room_id = rm.id
            and mu.muted_until is not null
            and mu.muted_until > now()), '{}'::json)
      ) as r from rooms rm) x), '[]'::json),
    /* ⚠ 消息增量必须分页，不能一次拉全表（S-095）。
       原来这里**没有任何 limit**：离线三天回来，一次拉回期间的全部消息。
       消息多到一定程度，这个请求会：
         - 超出网关响应体上限 → 直接失败
         - 或慢到超时，前端重试，于是**永远拉不下来**
       而失败的表现只是"消息一直是旧的"，用户看不出是拉取卡住了。

       ⚠ 但**不能简单加 limit 就完事** —— 那是最危险的做法：
         截断后前端拿到的是"一部分消息"，而 p_since 会推进到最新 rev，
         中间没拉到的那些**永远拉不到了**（下一次从新 rev 开始）。
         这就成了静默丢失：少了消息，且没有任何提示。

       所以必须同时返回游标：
         msgCursor = 本次这批消息的最大 rev
         msgMore   = 后面还有没有
       前端拿到 msgMore=true 时，用 msgCursor 继续拉，直到 false。
       ⚠ 消息游标必须**独立于全局 rev 保存** ——
         用全局 rev 覆盖它，就等于把没拉到的那批标成"已拉过"。 */
    'messages', coalesce((select json_agg(json_build_object(
        'id', t.id, 'room', t.room_id, 'from', t.from_id, 'type', t.type,
        'text', t.body, 'mediaId', t.media_path, 'name', t.media_name,
        'size', t.media_size, 'replyTo', t.reply_to,
        'deleted', t.deleted,
        'edited', t.edited_at,
        'ts', (extract(epoch from t.created_at) * 1000)::bigint
      ) order by t.rev) from (
        select m.id, m.room_id, m.from_id, m.type, m.body, m.media_path,
               m.media_name, m.media_size, m.reply_to, m.deleted,
               m.edited_at, m.created_at, m.rev
          from messages m
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
         order by m.rev
         limit 500
      ) t), '[]'::json),
    'msgCursor', coalesce((select max(t.rev) from (
        select m.rev from messages m
         where coalesce(m.rev, 0) >= coalesce(p_since, 0)
           and (
             exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
             or exists (select 1 from room_members mm
                        where mm.room_id = m.room_id and mm.user_id = me)
           )
         order by m.rev limit 500) t), coalesce(p_since, 0)),
    'msgMore', (select count(*) > 500 from (
        select 1 from messages m
         where coalesce(m.rev, 0) >= coalesce(p_since, 0)
           and (
             exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
             or exists (select 1 from room_members mm
                        where mm.room_id = m.room_id and mm.user_id = me)
           )
         order by m.rev limit 501) t),
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
  /* ⚠ 原来只判 gate_hash 是否为空。
     无门模式下 gate_hash 被清空，这个判断就失效了 ——
     任何人都能再调一次 site_init，**凭空造出第二个站长**。
     而 site_init 不检查 users 表是否已有 owner，所以这是真实可达的。
     补上 owner 检查：只要已存在站长，就永远不允许再初始化。 */
  if exists (select 1 from site where gate_hash is not null or gate_disabled) then
    raise exception '站点已初始化';
  end if;
  if exists (select 1 from users where role = 'owner') then
    raise exception '站点已存在站长，不能重复初始化';
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
declare tk text; st record; ok_new boolean; ok_old boolean; plain text; v_recent int;
begin
  select * into st from site where id = true;

  /* 无门模式（Q-Chat-S-120）：不校验任何密码，直接签发一个只读会话。
     前端据此跳过密码框。这里的会话是 gate_only ——
     它能读公开信息，但**不能发消息**（msg_send 要求 cur_user() 非空）。
     ⚠ 不能图省事返回一个"假的已登录会话"，那等于把匿名变成实名。 */
  if coalesce(st.gate_disabled, false) then
    /* ⚠⚠ Q-Chat-S-131：这里原来**没有任何限流**，每次调用都签发一个新会话。

       外部报告 C-2 说"门禁密码可无限爆破" —— 但实际情况比它说的更容易：
       **门禁已经被我们关闭了**（S-120），gate_check 无门分支
       不校验任何密码、直接发会话。攻击者连爆破都不用做，
       循环调用这一条就能把 sessions 表灌满。

       而 session_cleanup() 又恰恰对 anon 开放（同一份报告的 C-9），
       等于**灌的权力**和**清的权力**都在攻击者手上 ——
       他可以灌满，也可以顺手擦掉 login_attempts 里的痕迹。

       ★ 关于"plpgsql 里做不了限流"：
         文件里那句注释说的是"raise 会回滚 update，计数加不上去" ——
         这只排除了**写计数**（update 计数再 raise，计数被回滚）。
         **读计数不受影响**：先 select count 查已有多少，超阈值就 raise。
         查询本身不需要回滚保护。所以 plpgsql 里是可以限流的，
         那句注释把话说死了，导致这个口子一直敞开。 */
    select count(*) into v_recent from sessions
     where user_id is null
       and created_at > now() - interval '5 minutes';
    if v_recent >= 200 then
      raise exception '请求过于频繁，请稍后再试';
    end if;

    tk := issue_session(null, true);
    return json_build_object('ok', true, 'token', tk, 'show_new', null);
  end if;

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
  -- ⚠ 连字符必须放在字符类**末尾**（PG-REGEX，本次踩坑）。
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
/* ⚠⚠ Q-Chat-S-130（外部安全报告 C-3，已**实测确认**）：
   原来只查 gate_passed()，**不查 cur_user()** —— "过了门禁但没登录"的会话
   能拿到全站 users：realName / perms / bio / lastSeen / mutedUntil 全在下发字段里。

   实测（匿名，无任何会话）：
     gate_passed() = t（站点保护密码已关闭，见 S-120）
     cur_user()    = NULL
     state_get()   → 返回用户，realName=t perms=t bio=t lastSeen=t

   ★ 比报告描述的更严重：报告假设要先爆破门禁密码，
     但**门禁已被我们关闭**（S-120），所以不需要任何凭据。

   ★ 门禁与登录是两道独立的门：
     门禁 = 站点保护密码（可关闭，关闭后谁都能进站）
     登录 = 账号（始终要求）
     关掉门禁是"不用输站点密码"，**不是"不用登录就能看用户资料"**。
     原来把"过了门禁"当成"有身份"，两道门被混为一谈了。

   ⚠ 前端只在登录后调用（Online 模块需要会话），要求登录不会破坏流程。 */
create or replace function state_get()
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare me uuid;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
  me := cur_user();
  /* ★ 补上这道：没登录就不下发任何用户资料 */
  if me is null then raise exception '请先登录'; end if;
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
      select site_name, allow_register, (gate_hash is not null) as has_gate,
             -- Q-Chat-S-120：无门模式。前端据此跳过密码框。
             coalesce(gate_disabled, false) as gate_off from site where id = true) s),
    'users', coalesce((select json_agg(json_build_object(
        'id', u.id, 'nick', u.nick, 'realName', u.real_name, 'role', u.role,
        'status', u.status, 'perms', u.perms, 'bio', u.bio,
        'mutedUntil', (extract(epoch from u.muted_until) * 1000)::bigint,
        'createdAt', (extract(epoch from u.created_at) * 1000)::bigint,
        'lastSeen', (extract(epoch from u.last_seen) * 1000)::bigint,
        /* ⚠ rev 必须回传（S-085）。
           不回传的话前端只能拿 lastSeen 顶替"资料版本"，
           于是**每次上线都算一次"资料变更"**，合并判据彻底失真。 */
        'rev', u.rev
      )) from users u), '[]'::json),
    'rooms', coalesce((select json_agg(r) from (
      select json_build_object(
        'id', rm.id, 'name', rm.name, 'type', rm.type, 'owner', rm.owner_id,
        'desc', rm.description, 'notice', rm.notice,
        'hasPwd', (rm.pwd_hash is not null),
        'createdAt', (extract(epoch from rm.created_at) * 1000)::bigint,
        /* ⚠ rev 必须回传（S-085，这条最要紧）。
           rooms 表**根本没有 updated_at 列**，前端 tRoom 只能拿
           created_at 顶替 —— 而 created_at 永远不变。
           于是 mergeArr 的 `x.updatedAt > o.updatedAt` 恒为 false，
           **房间资料的合并分支永远不执行**：
           服务端改了房间名/公告，前端同步回来时被整个丢弃。
           这正是"公告改了不同步""置顶只改本地"那一族问题的共同根因。 */
        'rev', rm.rev,
        'members', coalesce((select json_agg(mm.user_id) from room_members mm where mm.room_id = rm.id), '[]'::json),
        'admins', coalesce((select json_agg(aa.user_id) from room_admins aa where aa.room_id = rm.id), '[]'::json),
        /* 被单独关掉邀请权的成员。
           不回传的话前端刷新一次开关就"自己弹回来"——
           而服务端其实已经禁掉了，界面与事实不符。 */
        'noInvite', coalesce((select json_agg(ni.user_id) from room_members ni
                              where ni.room_id = rm.id and ni.can_invite = false), '[]'::json),
        /* ⚠ 群内禁言必须回传（S-113）。
           不回传的话前端只能继续用本地 room.muted 数组 ——
           而数组改的是本地、换设备就没、被禁者自己改一下就解了，
           **服务端根本不知道有过这次禁言**。
           这里回传"仍在生效"的禁言：user_id → 到期时间戳（毫秒）。
           已过期的不再回传（前端据此自动解禁，不用等定时器）。 */
        'roomMuted', coalesce((select json_object_agg(
            mu.user_id,
            (extract(epoch from mu.muted_until) * 1000)::bigint)
          from room_members mu
          where mu.room_id = rm.id
            and mu.muted_until is not null
            and mu.muted_until > now()), '{}'::json)
      ) as r from rooms rm) x), '[]'::json),
    /* order by 必须写在 json_agg(...) 内部。
       写成 json_agg(x) ... order by m.created_at 会让整句变成聚合查询，
       报 "column must appear in the GROUP BY clause" —— 本地测试没跑到
       state_get 所以没暴露，真连上才炸。 */
    /* 同 state_delta：全量首次拉取也要分页（S-095）。
       这里只取最近 30 天内、**最新的 500 条**（按 rev 倒序再正序还原）。
       注意是"最新的"而不是"最旧的" ——
       首次打开时用户要看的是最近的消息，不是一个月前的。
       剩下更旧的由前端拿 msgCursor 继续往前补（见 msgMore）。 */
    'messages', coalesce((select json_agg(json_build_object(
        'id', t.id, 'room', t.room_id, 'from', t.from_id, 'type', t.type,
        'text', t.body, 'mediaId', t.media_path, 'name', t.media_name,
        'size', t.media_size, 'replyTo', t.reply_to,
        'deleted', t.deleted,
        'edited', t.edited_at,
        'ts', (extract(epoch from t.created_at) * 1000)::bigint
      ) order by t.rev) from (
        select m.id, m.room_id, m.from_id, m.type, m.body, m.media_path,
               m.media_name, m.media_size, m.reply_to, m.deleted,
               m.edited_at, m.created_at, m.rev
          from messages m
         where m.created_at > now() - interval '30 days'
           -- 只能看到自己所在房间的消息。
           -- 原来不加这层：私聊和别人的群聊会一视同仁全量返回。
           and (
             exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
             or exists (select 1 from room_members mm
                        where mm.room_id = m.room_id and mm.user_id = me)
           )
         order by m.rev desc limit 500
      ) t), '[]'::json),
    'msgCursor', coalesce((select min(t.rev) from (
        select m.rev from messages m
         where m.created_at > now() - interval '30 days'
           and (
             exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
             or exists (select 1 from room_members mm
                        where mm.room_id = m.room_id and mm.user_id = me)
           )
         order by m.rev desc limit 500) t), 0),
    'msgMore', (select count(*) > 500 from (
        select 1 from messages m
         where m.created_at > now() - interval '30 days'
           and (
             exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
             or exists (select 1 from room_members mm
                        where mm.room_id = m.room_id and mm.user_id = me)
           )
         limit 501) t),
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

/* ⚠ 群内禁言（S-113）—— 这条把"假禁言"变成真禁言。
   原来的状态：服务端 room_members.muted_until 列建好了，
   acl_can_speak 也会查它（第 2206 行附近），
   **但没有任何一个函数会往里写值**，而前端用的是 room.muted 数组。
   两套数据结构各走各的，于是群内禁言：
     - 只改本地，换设备就没了
     - 被禁者改一下本地数据就解了
     - 服务端根本不知道有过这次禁言
   等于"看着有这个功能，实际谁也管不住谁"。

   统一到服务端：写 room_members.muted_until，
   前端改为读这个时间戳（不再用本地数组）。
   ⚠ 权限必须用带房间的 acl_require ——
     不带房间的话会命中 ROOM_INHERENT 里的 user.mute，
     于是群主能借"群内禁言"清除别人的**全站**禁言（权限提升）。 */
create or replace function room_mute(p_room text, p_user uuid, p_minutes int default 10)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; mins int;
begin
  perform acl_require('room.mute', p_room);
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if p_user is null then raise exception '未指定成员'; end if;

  mins := coalesce(p_minutes, 10);
  if mins < 0 then mins := 0; end if;
  /* 上限 30 天：不限时长的话一次误操作就把人永久关在外面，
     而"永久"往往不是操作者的本意。 */
  if mins > 43200 then mins := 43200; end if;

  if not exists (select 1 from room_members where room_id = p_room and user_id = p_user) then
    raise exception '该用户不在此房间';
  end if;

  update room_members set muted_until =
    case when mins = 0 then null else now() + make_interval(mins => mins) end
   where room_id = p_room and user_id = p_user;

  insert into logs (who_id, act, detail)
  values (uid, case when mins = 0 then 'unmute' else 'mute' end,
          p_room || ':' || p_user::text || ' ' || mins || '分钟');
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

-- ⚠ 必须先删掉旧的 3 参数签名（PG-OVERLOAD，本次踩坑）。
--   PostgreSQL 的 CREATE OR REPLACE **改不了参数列表**：
--   加了第 4 个参数后，它不是替换原函数，而是**新建一个重载**。
--   于是两个版本并存，而 grant 只给了旧签名 ——
--   结果：不传自定义口令时走老版本（正常），传了就走新版本（permission denied）。
--   "有时能用有时没权限"这种错最难查，因为它看起来像权限配置飘了。
drop function if exists invite_create(text, int, int);

create or replace function invite_create(p_room text, p_hours int default 24, p_max_use int default 5,
                                          p_code text default null)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; v_code text; v_is_staff boolean; v_can boolean; i int;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;

  if not exists (select 1 from rooms r where r.id = p_room) then
    raise exception '房间不存在';
  end if;

  /* 房主 / 房间管理员 / 站长 / 全站管理员：不受 can_invite 开关限制 */
  select exists (
    select 1 from rooms r
     where r.id = p_room and (
       r.owner_id = uid
       or exists (select 1 from room_admins a where a.room_id = r.id and a.user_id = uid)
     )
  ) or exists (select 1 from users u where u.id = uid and u.role in ('owner','admin'))
    into v_is_staff;

  if not v_is_staff then
    /* 普通成员：先看是不是成员，再看有没有被单独禁掉邀请 */
    if not exists (select 1 from room_members m where m.room_id = p_room and m.user_id = uid) then
      raise exception '不是该房间成员';
    end if;
    select coalesce(m.can_invite, true) into v_can
      from room_members m where m.room_id = p_room and m.user_id = uid;
    if not v_can then
      raise exception '你在本房间的邀请权限已被管理员关闭';
    end if;
  end if;

  /* ⚠ 自定义口令（INV-CUSTOM）。
     随机 6 位码（A7K2M9 这种）**口头传达极其费劲**：
     你要一个字一个字念，对方还要反复确认"是 B 还是 D"。
     而邀请这件事恰恰大量发生在当面/电话里 —— 念一串无序字符是最糟的体验。

     所以给有权限的人一个选项：自己指定一个好说好记的词（hello、welcome、zhangsan）。

     权限：只有 v_is_staff（房主 / 房间管理员 / 站长 / 全站管理员）能自定义。
     普通成员仍只能拿随机码 —— 自定义口令占用的是"好记"这个稀缺命名空间，
     放开了会被抢注（welcome、admin、test 这类词会被占光）。

     校验（注意这些是**服务端**校验，前端只是提前提示）：
       - 3~24 位
       - 只放行小写字母与数字，统一转小写存储：
         大小写混着念是口头传达最大的错因（"是大写的 X 吗？"）
       - 显式拒绝易听错的字符 0/o/1/i/l —— 这几个是口头传达里出错率最高的
       - 撞码要明确报"已被占用"，而不是报主键冲突 */
  if coalesce(btrim(p_code), '') <> '' then
    if not v_is_staff then
      raise exception '只有房主、房间管理员和管理员可以设置自定义口令';
    end if;
    v_code := lower(btrim(p_code));
    if char_length(v_code) < 3 or char_length(v_code) > 24 then
      raise exception '自定义口令需 3~24 位';
    end if;
    if v_code !~ '^[a-z0-9]+$' then
      raise exception '自定义口令只能包含字母和数字（不能有空格、符号或汉字）';
    end if;
    if v_code ~ '[01ilo]' then
      raise exception '自定义口令不能包含 0/1/i/l/o —— 这几个口头传达时最容易听错';
    end if;
    /* ⚠ 只统计"仍然有效"的口令（INV-RELEASE）。
       原来无差别查 `exists (select 1 from invites where code = v_code)` ——
       于是**一个 1 小时前就过期、或早已作废的口令，仍然永久占着这个名字**。
       自定义口令恰恰都是好记的词（welcome / hello / zhangsan），
       这类词是稀缺命名空间：被一个已经没用的口令占住，
       后来的人就再也不能用，而界面只会说"已被占用"，
       看不出其实早就没人用了。

       所以撞码只看：未作废、未过期、次数没用完。
       历史行**不删除**（要留审计），但不再阻挡复用。 */
    if exists (select 1 from invites
                where code = v_code
                  and revoked_at is null
                  and (expire_at is null or expire_at > now())
                  and (max_use = 0 or used < max_use)) then
      raise exception '这个口令当前正被使用，换一个（已过期或已作废的口令会自动释放）';
    end if;
  else
    /* 生成 6 位随机口令，同样避开易混淆字符（0/O、1/I/L） */
    <<gen>>
    loop
      v_code := '';
      for i in 1..6 loop
        v_code := v_code || substr('abcdefghjkmnpqrstuvwxyz23456789',
                                   1 + floor(random() * 31)::int, 1);
      end loop;
      exit gen when not exists (select 1 from invites where code = v_code);
    end loop;
  end if;

  insert into invites (code, room_id, by_user, expire_at, max_use)
  values (v_code, p_room, uid,
          case when coalesce(p_hours,0) > 0 then now() + (p_hours || ' hours')::interval else null end,
          greatest(coalesce(p_max_use,0), 0));
  perform nextval('state_rev');
  return json_build_object('ok', true, 'code', v_code);
end;
$$;

-- 用邀请码加入房间。
-- 任何人拿到码都能用（这是邀请码的意义），但必须已登录且过了门禁。
create or replace function invite_redeem(p_code text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; v record; v_name text;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;

  /* 兼容历史大写口令：随机码此前生成大写，现在改小写，
     两个写法都要查，否则老口令会突然全部失效。 */
  /* ⚠ 释放机制生效后，同一个口令可能有多行历史记录（INV-RELEASE）：
     一条早就过期/作废的，加一条正在用的。
     `select ... into` 遇到多行会直接抛 "query returned more than one row"，
     用户看到的是一句谁也看不懂的数据库报错，而不是"口令不对"。
     所以取**最新**那条，再逐条判原因 —— 精确提示不能丢：
     "已被作废/已过期/次数用完"这三条对用户是完全不同的事。 */
  select * into v from invites
   where code in (lower(btrim(coalesce(p_code,''))), upper(btrim(coalesce(p_code,''))))
   order by created_at desc
   limit 1
   for update;

  if not found then raise exception '邀请码不存在'; end if;
  if v.revoked_at is not null then raise exception '邀请码已被作废'; end if;
  if v.expire_at is not null and v.expire_at < now() then raise exception '邀请码已过期'; end if;
  if v.max_use > 0 and v.used >= v.max_use then raise exception '邀请码使用次数已用完'; end if;

  if not exists (select 1 from rooms r where r.id = v.room_id) then
    raise exception '目标房间已被解散';
  end if;

  insert into room_members (room_id, user_id) values (v.room_id, uid) on conflict do nothing;
  update invites set used = used + 1 where code = v.code;
  select name into v_name from rooms where id = v.room_id;
  perform nextval('state_rev');
  return json_build_object('ok', true, 'room', v.room_id, 'name', v_name);
end;
$$;

-- 作废邀请码（生成者本人 / 房主 / 管理员）
create or replace function invite_revoke(p_code text)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; v record;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  /* ⚠ 随机码原本生成大写，改为小写后**历史口令必须还能用**（INV-CASE）。
     改成只查 lower 的话，老的大写口令会突然全部失效，
     而发出去的人不知道、拿到的人只会以为"口令错了"。
     所以两个写法都查一遍。 */
  select * into v from invites
   where code in (lower(btrim(coalesce(p_code,''))), upper(btrim(coalesce(p_code,''))))
   order by created_at desc
   limit 1;
  if not found then raise exception '邀请码不存在'; end if;
  if v.by_user <> uid
     and not exists (select 1 from rooms r where r.id = v.room_id and r.owner_id = uid)
     and not exists (select 1 from room_admins a where a.room_id = v.room_id and a.user_id = uid)
     and not exists (select 1 from users u where u.id = uid and u.role in ('owner','admin'))
  then raise exception '无权作废该邀请码'; end if;
  update invites set revoked_at = now() where code = v.code;
  perform nextval('state_rev');
  return true;
end;
$$;

-- ⚠ 列出我可见的邀请码（E-089，考古补回）。
-- 服务端 invite_revoke() 早就写好了，前端也导出了 inviteRevoke，
-- 但**全仓零处调用** —— 因为界面上根本没有地方能列出已生成的口令。
--
-- 后果很具体：生成一个「长期有效 · 不限次数」的口令之后，
-- **就再也没有任何办法收回它**。口令只能等它自然过期或用完，
-- 而"长期不限"这一项意味着那一天永远不会来。
-- 于是一个本该是临时凭证的东西，变成了永久后门，且管理员看不见它。
--
-- 可见范围：我生成的 + 我作为房主/管理员/站长的房间里的。
-- 已作废的也列出来（标 revoked_at）：不知道自己作废过什么，
-- 和不知道自己发过什么一样危险。
create or replace function invite_list()
returns table (
  code text, room_id text, room_name text, by_user uuid,
  expire_at timestamptz, max_use int, used int,
  revoked_at timestamptz, created_at timestamptz
) language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  return query
    select i.code, i.room_id, r.name, i.by_user,
           i.expire_at, i.max_use, i.used,
           i.revoked_at, i.created_at
    from invites i
    left join rooms r on r.id = i.room_id
    where i.by_user = uid
       or exists (select 1 from rooms rr where rr.id = i.room_id and rr.owner_id = uid)
       or exists (select 1 from room_admins a where a.room_id = i.room_id and a.user_id = uid)
       or exists (select 1 from users u where u.id = uid and u.role in ('owner','admin'))
    order by i.created_at desc
    limit 200;
end;
$$;

-- 开关某个成员「能不能邀请别人」
create or replace function member_set_can_invite(p_room text, p_user uuid, p_can boolean)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  -- 只有房主 / 房间管理员 / 站长 / 全站管理员能改别人的开关
  if not exists (select 1 from rooms r where r.id = p_room and (
       r.owner_id = uid
       or exists (select 1 from room_admins a where a.room_id = r.id and a.user_id = uid)
     ))
     and not exists (select 1 from users u where u.id = uid and u.role in ('owner','admin'))
  then raise exception '无权设置'; end if;

  update room_members set can_invite = coalesce(p_can, true)
   where room_id = p_room and user_id = p_user;
  if not found then raise exception '该用户不是本房间成员'; end if;
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
  if p_status = 'banned' then perform self_guard(p_user, '封禁'); end if;
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
  perform self_guard(p_user, '禁言');
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
  /* 不能改自己的角色：把自己降为 member 会立刻失去全部管理权限，且无法自恢复 */
  perform self_guard(p_user, '调整角色');
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

/* 权限分配：perms = 显式授予，denied = 显式禁止（优先级更高）。
   原来只有 p_perms，前端权限矩阵里选的「禁止」无处可存 —— 迁移缺口。 */
create or replace function user_perms_set(p_user uuid, p_perms text[], p_denied text[] default null)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  -- 服务端权限校验（前端判定只能决定按钮显不显示，这里才是真正的闸门）
  perform acl_require('user.perms');
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  /* 不能改自己的权限：给自己加 denied 就再也拿不掉，等于自锁 */
  perform self_guard(p_user, '调整权限');
  if not exists (select 1 from users u where u.id = uid and u.role = 'owner') then
    raise exception '仅站长可调整权限';
  end if;
  update users set
    perms  = coalesce(p_perms, '{}'),
    denied = coalesce(p_denied, '{}')
  where id = p_user;
  insert into logs (who_id, act, detail) values (uid, 'perm',
    p_user::text || ' 允许[' || array_to_string(coalesce(p_perms,'{}'), ',') ||
    '] 禁止[' || array_to_string(coalesce(p_denied,'{}'), ',') || ']');
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
  perform self_guard(p_user, '删除');
  /* ⚠ 删账号必须留痕（S-064）。 */
  insert into logs (who_id, act, detail, target)
  values (uid, 'user.delete', '删除账号', p_user::text);
  delete from users where id = p_user;
  perform nextval('state_rev');
  return true;
end;
$$;

/* 按路径取媒体链接（前端拿到的 mediaId 若是 storage 路径就走这个）。
   鉴权同 media_url：必须是该房间成员，或是上传者本人。 */
create or replace function media_url_by_path(p_path text)
returns text language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; m record; v_url text;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  select * into m from media_objects where path = p_path;
  if not found then return null; end if;
  if m.uploader <> uid then
    if not exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
       and not exists (select 1 from room_members mm
                       where mm.room_id = m.room_id and mm.user_id = uid) then
      raise exception '无权访问该媒体';
    end if;
  end if;
  /* ⚠ 签名失败原来静默返回 null（S-074）。
     用户看到的是一张破图，而背后可能是三种完全不同的情况：
       ① 签名接口挂了     —— 等一会儿就好
       ② 没权限           —— 再试多少次也没用
       ③ 文件真没了       —— 永远不可能再显示
     三种失败被合并成同一种表现（破图），
     用户既不知道该怎么办，也没法向站长描述问题。

     所以抛错并带上原因。前端拿到明确原因，
     才能告诉用户"是权限问题"还是"文件已不存在"。 */
  begin
    execute 'select storage.create_signed_url($1, $2, $3)'
      into v_url using 'media', m.path, 3600;
  exception when others then
    raise exception '媒体签名失败（可能文件已不存在或存储不可用）：%', SQLERRM;
  end;
  if v_url is null then
    raise exception '媒体签名返回空（文件可能已被删除）';
  end if;
  return v_url;
end;
$$;

/* 回填消息的云端媒体路径（前端上传成功后再调）。
   只有消息作者本人能改，且必须已经过发消息权限。 */
create or replace function msg_media(p_msg uuid, p_media text)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  update messages set media_path = p_media
   where id = p_msg and from_id = uid;
  if not found then raise exception '消息不存在或不是你发的'; end if;
  /* 同上：update 由触发器 bump rev */
  return true;
end;
$$;

-- 个人资料
/* ⚠⚠ PG-OVERLOAD 陷阱（本仓库已踩过多次）：
   create or replace function 在**签名变化**时会**新建重载**而不是替换。
   加一个参数就属于签名变化 —— 于是线上同时存在 3 参和 4 参两个版本，
   PostgREST 报 "Could not choose the best candidate function"。
   改签名必须**先显式 drop**。 */
drop function if exists profile_update(text, text, text);

create or replace function profile_update(p_nick text default null, p_real text default null,
                                          p_bio text default null, p_avatar text default null)
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
    bio = coalesce(p_bio, bio),
    /* ⚠ 用 coalesce 就永远删不掉头像 —— 传 null 会被当成"没传"。
       所以要区分：'' 表示明确清空，null 表示保持原样。 */
    avatar = case when p_avatar = '' then null
                  else coalesce(p_avatar, avatar) end
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
  /* 改密码留痕（S-064）。明细只记"改了"，不记新旧密码 ——
     日志本身不能成为泄密源。 */
  insert into logs (who_id, act, detail, target)
  values (uid, 'user.password', '修改登录密码', uid::text);
  return true;
end;
$$;

-- ---------- 本机桥接票据 ----------
-- 场景：桌面版/安卓版已经登录，网页端想"直接进"，不再输一遍账号密码。
-- 链路：客户端（已登录）向服务端申领票据 → 通过本机 HTTP 服务交给网页
--      → 网页拿票据换会话。
--
-- 为什么安全：
--   · 票据由【已登录的客户端】申领，服务端绑定 uid —— 网页造不出来
--   · 库里只存哈希，泄露也换不出可用票据
--   · 单次使用 + 5 分钟过期
--   · 客户端只把票据交给 Origin 白名单内的网页（见 electron/local-bridge.js）
create table if not exists bridge_ticket (
  code_hash  text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  origin     text not null default '',  -- 申领时的网页来源；兑换时校验，防止票据搬运
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists bridge_ticket_user_idx on bridge_ticket(user_id);

-- 老库补列：表已存在时 create table if not exists 不会加新列
alter table bridge_ticket add column if not exists origin text not null default '';

-- 客户端（已登录）申领一枚票据，返回明文；明文只在返回这一刻存在。
-- 申领时把网页来源一起记下来（p_origin）。
-- 兑换端校验它 —— 票据即使被搬到别的机器上也换不出会话。
create or replace function bridge_ticket_create(p_origin text default '')
returns text language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; code text;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;

  delete from bridge_ticket where user_id = uid and (expires_at < now() or used_at is not null);
  if (select count(*) from bridge_ticket where user_id = uid) >= 5 then
    raise exception '待使用的票据过多';
  end if;

  code := encode(gen_random_bytes(24), 'hex');
  insert into bridge_ticket (code_hash, user_id, origin, expires_at)
  values (encode(digest(code || '|br-v1', 'sha256'), 'hex'), uid,
          left(coalesce(p_origin, ''), 200), now() + interval '5 minutes');
  return code;
end;
$$;

-- 先删旧签名。
-- create or replace 对【不同参数列表】是新建重载而非替换，
-- 不 drop 的话 select bridge_ticket_redeem(p_code) 会精确匹配到旧版本，
-- 新加的来源校验静默失效 —— 不报错，只是没生效。
drop function if exists bridge_ticket_create();
drop function if exists bridge_ticket_redeem(text);

-- 网页兑换票据。
-- 【不】要求先过门禁：网页端的流程是「先输保护密码 → 再到登录页」，
-- 门禁在前面已经过过了。且换到的只是账号身份，所有数据接口仍各自校验门禁。
--
-- 这条豁免的代价要记着：它给了"绕过门禁直接拿账号会话"一条路径，
-- 所以票据必须是短时（5 分钟）、单次、且只能由已登录客户端申领。
-- p_origin 必须与申领时一致（都为空也算一致，供无来源的场景使用）。
-- 这一层校验的意义：票据即使用 curl 从本机 127.0.0.1 拿到，
-- 搬到另一台机器上兑换也会因为来源不符被拒。
create or replace function bridge_ticket_redeem(p_code text, p_origin text default '')
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; tk text; u record; o text;
begin
  if coalesce(length(p_code), 0) < 32 then
    return json_build_object('ok', false, 'err', '票据无效');
  end if;

  select t.user_id, t.origin into uid, o from bridge_ticket t
  where t.code_hash = encode(digest(p_code || '|br-v1', 'sha256'), 'hex')
    and t.used_at is null and t.expires_at > now();

  if uid is null then
    return json_build_object('ok', false, 'err', '票据无效或已过期');
  end if;

  if coalesce(o, '') <> coalesce(p_origin, '') then
    return json_build_object('ok', false, 'err', '票据与当前访问来源不符');
  end if;

  update bridge_ticket set used_at = now()
  where code_hash = encode(digest(p_code || '|br-v1', 'sha256'), 'hex');

  select * into u from users where id = uid;
  if u.status <> 'active' then
    return json_build_object('ok', false, 'err', '账号未激活或已被停用');
  end if;

  tk := issue_session(u.id, false);
  update users set last_seen = now() where id = u.id;
  insert into logs (who_id, act, detail) values (u.id, 'login_bridge', '本机桥接免密登录');
  return json_build_object('ok', true, 'token', tk, 'uid', u.id, 'nick', u.nick);
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
  if p_new = p_old then raise exception '新密码不能与旧密码相同'; end if;

  /* 宽限：留一次用旧密码登录的机会。
     新密码用旧密码派生的密钥加密后暂存 —— 这样服务端不存明文，
     只有拿旧密码进来那一刻才解得开，用来把新密码展示给他看。
     注意：改密码的人如果自己也没记住，旧密码这次就是他的退路。 */
  update site set
    gate_hash      = crypt(p_new, gen_salt('bf', 10)),
    gate_prev_hash = crypt(p_old, gen_salt('bf', 10)),
    gate_new_enc   = pgp_sym_encrypt(p_new,
                       encode(digest(p_old || '|gate-grace-v1', 'sha256'), 'hex')),
    gate_grace     = 1
  where id = true;

  insert into logs (who_id, act, detail) values (uid, 'gate', '修改保护密码（保留 1 次旧密码宽限）');
  return true;
end;
$$;

/* ----------------------------------------------------------------
   site_info() —— 站点"公开信息"（Q-Chat-S-135）

   ★ 为什么不能沿用 state_get()：跟 user_list() 那条同样的理由 ——
     state_get 是为聊天室设计的全量状态，含房间、消息、成员，几十 KB 起。
     而站点设置页只要四个字段。在主页拉全量状态，
     既慢，又把聊天室的数据结构暴露到别的页面。

   ⚠ 分级返回（与 user_list 同一套思路）：
     · 任何人：站点名（导航条要显示）
     · 管理组成员：额外拿到 allowRegister / 门禁状态
     为什么门禁状态不公开：它属于安全配置。
     让陌生人知道"这座站现在有没有门"没有正当用途，
     只在探测时有用。
---------------------------------------------------------------- */
create or replace function site_info() returns json
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; staff boolean; r record;
begin
  uid := cur_user();
  staff := (uid is not null) and exists (
    select 1 from users u where u.id = uid and u.role in ('owner','admin'));

  select site_name, allow_register,
         (gate_hash is not null) as has_gate,
         coalesce(gate_disabled, false) as gate_off
    into r from site where id = true;

  if r.site_name is null then
    return json_build_object('ok', false, 'err', '站点尚未初始化');
  end if;

  if not staff then
    return json_build_object('ok', true, 'siteName', r.site_name,
      /* ⚠ 非管理员也要知道"有没有门" —— 否则登录页不知道该不该弹密码框。
         但**不告诉** allowRegister 和门是否已关（那是安全配置细节）。 */
      'hasGate', r.has_gate, 'gateOff', r.gate_off);
  end if;

  return json_build_object('ok', true,
    'siteName', r.site_name,
    'allowRegister', r.allow_register,
    'hasGate', r.has_gate,
    'gateOff', r.gate_off);
end;
$$;

grant execute on function site_info() to anon, authenticated;

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
  /* 站点设置留痕（S-064）：改站名、开关注册都影响全站。
     把改成什么写进 detail —— 事后要能看出"是谁放开了注册"。 */
  insert into logs (who_id, act, detail, target)
  values (uid, 'site.set',
    coalesce('站名=' || p_name || ' ', '')
    || coalesce('允许注册=' || p_allow_register::text, ''),
    'site');
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

  /* login_attempts 也必须在这里清（S-007）。
     原来只在"登录成功"时顺手删 24 小时前的记录 ——
     那么纯爆破路径（永远不成功）会让这张表无限增长，
     而爆破恰恰是最需要防的场景。清理不能依赖攻击者配合。 */
  delete from login_attempts where created_at < now() - interval '24 hours';

  /* 所有会自然过期/堆积的凭据表都要在这里清，不能只清 sessions。
     bridge_ticket 刚加时就漏了 —— 跟门禁会话堆积是同一类缺陷。 */
  delete from bridge_ticket where expires_at < now() or used_at is not null;

  /* 失效的邀请口令（INV-RELEASE）。
     撞码检查已经不再被它们阻挡（看的是"仍有效"），
     但**行本身还留在表里**。留一段时间是必要的 ——
     "谁在什么时候发过什么口令"是审计信息，不能一过期就抹掉。

     不过也不能无限堆积：口令是会被反复生成的。
     这里留 30 天，之后清掉。30 天内仍可追溯，之外不再占空间。 */
  delete from invites
   where (revoked_at is not null and revoked_at < now() - interval '30 days')
      or (revoked_at is null and expire_at is not null
          and expire_at < now() - interval '30 days');

  /* 未提交的媒体记录（S-009）。
     media_prepare() 插 committed=false 的记录占好路径，
     用户中途放弃上传（关页面、断网、改主意）就永远留下 ——
     还占着 storage 里已经传上去的字节。
     留 24 小时宽限：正常上传不会超过这个时间。

     ⚠ 必须放在这里，不能放在"某人登录成功"时 ——
     那等于清理依赖有人来登录，跟 S-007 是同一个错误。 */
  delete from media_objects
   where committed = false
     and created_at < now() - interval '24 hours';

  /* 门禁会话只保留最近 200 条，多的删掉。
     门禁每次成功检查都建一条，且没有限流（plpgsql 里 raise 会回滚，
     失败计数加不上去 —— 真实限流只能在网关层做）。
     所以这里必须有兜底：不管多频繁地刷，总量都压在 200 条以内。
     200 够用了 —— 这是"同时有多少台设备过过门禁"的量级，不是用户数。 */
  delete from sessions
   where gate_ok = true
     and user_id is null
     and ctid not in (
       select ctid from sessions
        where gate_ok = true and user_id is null
        order by expires_at desc
        limit 200
     );

  return n;
end;
$$;

-- 老库补丁（幂等，重复执行安全）
alter table users        add column if not exists denied      text[] not null default '{}';
alter table room_members add column if not exists muted_until timestamptz;



-- ==================================================================
-- 自操作保护（站长误伤自己）
--
-- 事故：站长在管理面板里把自己封禁了，之后进不去、也没法自解 ——
--       因为封禁状态下除 msg.send 外全部权限失效，而解封需要 audit.review。
--       user_delete 有"不能删除自己"，但封禁/降级/改权限都没有，属于保护残缺。
--
-- 规则：
--   1. 不能封禁/停用自己
--   2. 不能改自己的角色（降级会把自己锁在外面；转让走 user_transfer）
--   3. 不能改自己的权限（denied 一旦加上就再也拿不掉）
--   4. 不能删自己（已有，统一收进来）
--   5. 唯一站长不允许被停用 —— 否则站点永久失去管理者
-- ==================================================================

create or replace function self_guard(p_target uuid, p_action text)
returns void language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; cnt int;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;

  if p_target = uid then
    raise exception '不能对自己执行「%」', p_action;
  end if;

  /* 唯一站长保护：停用最后一个 owner 会让站点永久失去管理者 */
  if p_action in ('封禁', '停用', '删除') then
    select count(*) into cnt from users where role = 'owner' and status <> 'banned';
    if exists (select 1 from users where id = p_target and role = 'owner')
       and cnt <= 1 then
      raise exception '这是唯一可用的站长，不能%s', p_action;
    end if;
  end if;
end;
$$;

-- 站长自救：即便被误封，也能凭站长身份把自己恢复。
-- 没有这条，封禁自己 = 站点永久失去管理者。
create or replace function user_self_unban()
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (select 1 from users where id = uid and role = 'owner') then
    raise exception '仅站长可用';
  end if;
  update users set status = 'active', muted_until = null where id = uid;
  insert into logs (who_id, act, detail) values (uid, 'unban', '站长自助解封');
  perform nextval('state_rev');
  return true;
end;
$$;

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
      'msg.send','msg.recall.own','msg.edit','msg.remove','msg.delete','msg.viewRaw','msg.pin',
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
      'room.mute',
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
    'room.invite','room.kick','room.delete','room.export','user.mute',
    'room.mute'
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
/* ⚠⚠ 改签名必须显式 drop（PG-OVERLOAD 陷阱，本仓库已踩多次）：
   create or replace 在签名变化时**新建重载**而不是替换。
   不加 drop 的话线上会同时存在两参和三参两个版本，
   PostgREST 报 "Could not choose the best candidate function"。 */
drop function if exists acl_can(text, text);

/* ==================================================================
   acl_can —— 唯一的权限判定入口（Q-Chat-S-125）
   ==================================================================

   三参数（后两个可选，"二餐变三餐"）：
     acl_can(权限)                两餐的旧调用照旧能用
     acl_can(权限, 房间)          房间级
     acl_can(权限, 房间, 用户)    判定**指定用户**（跨项目场景）

   ⚠ 为什么是"加参数"而不是"另起 site_can"：
     跨项目权限（能不能用云盘）与房间内权限（能不能删这条消息）
     **本质是同一套体系**，只是作用域不同。
     分成两个函数的话，"站长恒有""显式禁止优先于显式授予"
     这些规则就要写两遍，改一处忘一处的风险无法避免。
     所以统一成一个入口，用 p_room 的有无来区分作用域。

   ⚠ 这是**闸门**，不是前端参考：
     返回 false 意味着服务端会拒绝操作。真正的强制点在
     acl_require() —— 项目在自己的服务端函数里调用它，
     被拒绝直接 raise exception，操作根本不会发生。
     前端调 acl_can 只是为了决定"要不要显示这个按钮"，
     那个判定永远可以被绕过，不能当作安全边界。
================================================================== */
create or replace function acl_can(
  p_perm text,
  p_room text default null,
  p_user uuid default null
) returns boolean
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare
  uid uuid; u record; subs text[]; caller uuid; can_probe boolean;
begin
  if p_perm is null then return false; end if;

  caller := cur_user();
  if caller is null then return false; end if;

  /* ── 判定对象：不传 p_user = 判定调用者自己 ── */
  if p_user is null then
    uid := caller;
  else
    /* ⚠ 查别人的权限必须自己是管理员/站长，或者是查自己。
       不设这道限制的话，任何登录用户都能枚举出所有人
       在别的项目里的权限 —— 那是信息泄露。 */
    select exists(select 1 from users c
                  where c.id = caller and c.role in ('owner','admin')) into can_probe;
    if p_user <> caller and not can_probe then return false; end if;
    uid := p_user;
  end if;

  select * into u from users where id = uid;
  if not found then return false; end if;

  -- 2) 封禁：除发言外全部拒绝（发言仍允许，好让人知道自己被封了）
  if u.status = 'banned' and p_perm <> 'msg.send' then return false; end if;

  -- 3) 聚合键
  subs := acl_aggregate(p_perm);
  if subs is not null then
    return exists (
      select 1 from unnest(subs) as sp where acl_can(sp, p_room, uid)
    );
  end if;

  -- 4) 站长恒为全部权限
  if u.role = 'owner' then return true; end if;

  -- 5) 显式禁止（优先级最高，站长已在上面放行）
  if p_perm = any (coalesce(u.denied, '{}'::text[])) then return false; end if;

  -- 6) 显式授予
  if p_perm = any (coalesce(u.perms, '{}'::text[])) then return true; end if;

  /* 7) 跨项目权限点的角色默认 —— **读注册表 site_perms**，
        不写死在函数里。写死的话加一个权限点就要改函数，
        而改函数又要防 PG-OVERLOAD，链路太长。 */
  if exists (
    select 1 from site_perms sp
    where sp.key = p_perm and u.role = any (sp.default_roles)
  ) then return true; end if;

  -- 8) 角色默认（房间级权限点，沿用原有硬编码清单）
  if p_perm = any (acl_role_perms(u.role)) then return true; end if;

  -- 9) 房主 / 房管的固有权力
  if p_room is not null
     and acl_room_role(p_room) in ('roomOwner','roomAdmin')
     and p_perm = any (acl_room_inherent()) then return true; end if;

  return false;
end;
$$;

/* ================================================================
   acl_require —— 闸门本体（项目在自己的服务端函数里调这个）
   ----------------------------------------------------------------
   ⚠ 这才是"帮项目做主的闸门"，不是前端判定：
     被拒绝时直接 raise exception，PostgREST 把事务回滚，
     操作根本不会发生。前端调 acl_can 只为显示按钮，
     那个永远可以被绕过 —— 安全只能建立在这里。

   用法（在各项目自己的 RPC 函数里）：
       perform acl_require('drive.use');
       perform acl_require('archive.write', null, 目标用户);
================================================================ */
drop function if exists acl_require(text, text);

create or replace function acl_require(
  p_perm text,
  p_room text default null,
  p_user uuid default null
) returns boolean
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  if cur_user() is null then raise exception '请先登录'; end if;
  if not acl_can(p_perm, p_room, p_user) then
    raise exception '没有「%」权限', coalesce(
      (select value from acl_perm_label where key = p_perm),
      (select label from site_perms sp where sp.key = p_perm),
      p_perm);
  end if;
  return true;
end;
$$;

/* ================================================================
   acl_why —— 诊断视图（返回状态值，供界面显示"为什么不能"）
   ----------------------------------------------------------------
   ⚠ 它**不是闸门**，只用来回答"为什么"。
     返回 boolean 的 acl_can 答不了这个：
     "被单独禁止""被封禁""权限点没注册"三种情况
     在界面上长得一模一样，用户只会以为功能坏了。
================================================================ */
create or replace function acl_why(
  p_perm text,
  p_room text default null,
  p_user uuid default null
) returns text
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare
  uid uuid; u record; caller uuid; can_probe boolean; reg boolean;
begin
  if p_perm is null then return 'unknown'; end if;
  caller := cur_user();
  if caller is null then return 'no_user'; end if;

  if p_user is null then uid := caller;
  else
    select exists(select 1 from users c
                  where c.id = caller and c.role in ('owner','admin')) into can_probe;
    if p_user <> caller and not can_probe then return 'no_perm'; end if;
    uid := p_user;
  end if;

  select * into u from users where id = uid;
  if not found then return 'no_user'; end if;

  if u.status = 'banned' and p_perm <> 'msg.send' then return 'banned'; end if;

  /* 权限点必须已注册。拼错的名字在这里被抓住 ——
     若静默放行，等于那道检查根本不存在。 */
  select exists(select 1 from site_perms sp where sp.key = p_perm) into reg;
  if not reg and not exists (select 1 from acl_perm_label l where l.key = p_perm)
     and acl_aggregate(p_perm) is null
     and not (p_perm = any (acl_role_perms('owner'))) then
    return 'unknown';
  end if;

  if acl_can(p_perm, p_room, uid) then return 'ok'; end if;

  if p_perm = any (coalesce(u.denied, '{}'::text[])) then return 'denied'; end if;

  return 'no';
end;
$$;

grant execute on function acl_can(text, text, uuid) to anon, authenticated;
grant execute on function acl_require(text, text, uuid) to anon, authenticated;
grant execute on function acl_why(text, text, uuid) to anon, authenticated;


/* ==================================================================
   site_perms —— ACL 权限注册表（Q-Chat-S-125）
   ==================================================================
   与 acl_perm_label（纯中文名）不同，这张表是**可配置的权限点**：
     · project  所属项目 → 删项目时整组删，一行搞定
     · scope    作用域：'site' 跨项目（不用房间）/ 'room' 房间级
     · default_roles  哪些角色默认拥有

   ⚠ 角色默认**从这里读**，不写死在 acl_can 函数体里 ——
     写死的话加一个权限点就要改函数，而改函数又要防 PG-OVERLOAD。

   ⚠ 不建 RLS：这是权限点的**定义表**，真正的闸门在函数体的 if 里。
     建了 RLS 反而会让"读权限点定义"也被权限挡住，
     而权限页要先列出所有权限点才能配置 —— 那是死锁。
================================================================== */
create table if not exists site_perms (
  key           text primary key,
  project       text not null,
  label         text not null default '',
  scope         text not null default 'site',
  default_roles text[] not null default '{}'::text[],
  created_at    timestamptz not null default now()
);

/* ⚠ 已存在的表不会被 create table if not exists 更新 ——
   线上这张表是上一版建的（没有 scope 列），
   于是后面的 insert 报 column "scope" does not exist。
   加列必须用 alter，这是"改已存在表"和"建新表"的区别。 */
alter table site_perms add column if not exists scope text not null default 'site';

/* 已注册的跨项目权限点。
   ⚠ 命名规则：<项目>.<动作>。
   项目删掉时：delete from site_perms where project = 'xxx';
   一行搞定，其余项目不受影响。 */
/* ⚠⚠ Q-Chat-S-127：权限点名字必须跟**实际检查的那个**一致，不能另起一套。
     Archive 与 Chat 连的是**同一个库**（pimryrsxkwyafmponegp.supabase.co），
     共用同一份 users / sessions / acl_can。
     而 Archive 的每个函数检查的是 `acl_require('site.profile')` ——
     我上一轮却在注册表里写了 `archive.read` / `archive.write`。

     后果：**在权限页给 admin 开"查看档案"是无效的**。
     页面上是的，Archive 根本不查它，admin 照样进不去。
     这就是"分两套必然漂移"的实害 —— 而且是**静默的**：
     配置界面看起来正常，点了也提示成功，实际什么都没发生。

     所以这里以**实际生效的 key** 为准：注册 site.profile，
     并删掉那两个没人检查的 archive.read / archive.write。
     留着假权限点比不留更危险 —— 它让人以为配置过了。

     ⚠ 为什么不改 Archive 去用 archive.read：
       那要动 20 处 acl_require，而改名期间若有一处漏改，
       就是"某个功能突然谁都能用"。保留既成事实的 key，风险最低。 */
delete from site_perms where key in ('archive.read','archive.write');

insert into site_perms (key, project, label, scope, default_roles) values
  ('drive.use',      'drive',   '使用云盘',     'site', array['owner','admin']),
  ('drive.admin',    'drive',   '云盘管理',     'site', array['owner']),
  ('site.profile',   'archive', '人物档案',     'site', array['owner']),
  ('code.run',       'code',    '在线运行代码', 'site', array['owner','admin','member']),
  ('code.runtime',   'code',    '管理运行时',   'site', array['owner'])
on conflict (key) do update set
  project = excluded.project,
  label = excluded.label,
  scope = excluded.scope,
  default_roles = excluded.default_roles;

/* 权限点清单（按项目分组）。⚠ 仅管理员 ——
   权限点清单本身就是一份"系统能力地图"，
   让普通成员看到会暴露还没上线的项目。 */
create or replace function acl_perms_list() returns json
language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; isadmin boolean;
begin
  uid := cur_user();
  if uid is null then return json_build_object('ok', false, 'err', 'not logged in'); end if;
  select exists(select 1 from users u where u.id = uid and u.role in ('owner','admin'))
    into isadmin;
  if not isadmin then return json_build_object('ok', false, 'err', 'no perm'); end if;

  return json_build_object('ok', true, 'perms', coalesce((
    select json_agg(json_build_object(
      'key', sp.key, 'project', sp.project, 'label', sp.label,
      'scope', sp.scope, 'defaultRoles', sp.default_roles
    )) from site_perms sp order by sp.project, sp.key
  ), '[]'::json));
end;
$$;

grant execute on function acl_perms_list() to anon, authenticated;

-- 闸门本体见上方 acl_require(perm, room, user)（三参数，Q-Chat-S-125）

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
  /* ⚠ room.mute 是 S-113 新增的**独立权限点**。
     不能直接复用 user.mute —— 那个在 ROOM_INHERENT 里，
     不带房间调用会命中固有权力，导致群主能借"群内禁言"
     清掉别人的**全站**禁言（权限提升，见 room_mute 注释）。 */
  ('room.mute','群内禁言'),
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
/* ⚠ Q-Chat-S-136：上面这行全局 grant 已删除，改白名单（见文件末尾）。
   保留注释说明它曾经在这里，免得将来有人又加回去。 */

/* ⚠ 上面那句 all functions 会把内部辅助函数一并暴露给 anon（S-058）：
   issue_session / new_token / cur_token / cur_token_hash 等
   本不该被外部直接调用 —— 它们是会话机制的内部零件。

   这里逐个收回内部函数。

   **为什么不用"全部收回 + 白名单放开"：**
   那更安全，但本项目对外函数有几十个，
   漏放一个就是功能直接不可用，而这类缺失在上线前未必测得到。
   收回内部函数则相反：漏收一个只是没收紧，不会破坏任何功能。
   **收紧安全边界时，要选"漏了也不会坏"的那个方向。** */
do $$
declare fn text;
begin
  foreach fn in array array[
    'issue_session(uuid)', 'new_token()', 'cur_token()', 'cur_token_hash()',
    'cur_user()', 'gate_passed()', 'acl_can(text,text)',
    'acl_require(text,text)', 'msg_rev_bump()'
  ]
  loop
    begin
      execute format('revoke execute on function %s from anon, authenticated', fn);
    exception when undefined_function then
      /* 函数不存在就跳过 —— 收紧权限不该反过来搞挂部署 */
      null;
    end;
  end loop;
end $$;

/* 上面这些 revoke 里，凡是参数类型对不上或函数不存在的，
   执行时会报 error 而不是静默跳过 —— 一条报错就会中断整份迁移。
   所以逐个用 do 块包起来：不存在就跳过，不影响主流程。
   （下面用动态 SQL 实现，避免"为了收紧权限反而把部署搞挂"。） */
/* ⚠ Q-Chat-S-131（外部报告 C-9）：原来给 anon 是为了"外部定时调用方便"，
   但它**同时**清 login_attempts —— 攻击者可以用它擦掉自己的爆破痕迹。

   "清理自己的痕迹"这件事不该对匿名开放，方便性远不值这个代价。

   ⚠ 收回后谁来做清理：
     · GitHub Actions 的 db-run 用的是 SUPABASE_DB_URL（postgres 角色），
       不受 anon 权限限制，可以照常调用
     · 或者由 issue_session 里的惰性清理兜底（见下）
   所以收回不等于没人清理。 */
revoke execute on function session_cleanup() from anon;
grant execute on function session_cleanup() to authenticated;

-- Storage：媒体桶
-- public=true 且零策略 = 匿名可读可写的公开文件托管点。
-- 被扫到会当图床用，免费版带宽配额（约 5GB/月）第一个月就超。
-- 改成私有：读写一律走服务端签发的短时 URL，不对外敞开。
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;
update storage.buckets set public = false where id = 'media';


-- ==================================================================
-- 媒体上传（跨设备可见）
--
-- 背景：媒体原本只存 IndexedDB，换设备就看不到了。
--
-- 难点：桶已改成私有（防被当图床），但本项目用的是自建会话，
--       没有 Supabase Auth 的 JWT，拿不到 authenticated 角色，
--       因此不能直接靠 `to authenticated` 策略上传。
--
-- 方案：先过我们自己的鉴权申请一个"待上传"槽位，再让客户端拿 anon key
--       往那个精确路径上传。storage 的插入策略调 media_upload_allowed()，
--       只有"刚被服务端登记过、且还没提交"的路径才允许写入。
--       攻击者无法绕过：他拿不到槽位，因为申请槽位要过门禁 + 房间成员 + 权限。
-- ==================================================================

create table if not exists media_objects (
  id         uuid primary key default gen_random_uuid(),
  room_id    text not null,
  uploader   uuid references users(id) on delete cascade,
  name       text not null default '',
  size       bigint not null default 0,
  path       text not null unique,
  committed  boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists media_objects_path_idx on media_objects(path);
create index if not exists media_objects_time_idx on media_objects(created_at desc);

/* 申请上传槽位。返回 {id, path}。
   鉴权：过了门禁 + 是该房间成员 + 有 media.send 权限 + 体积不超上限。 */
create or replace function media_prepare(p_room text, p_name text, p_size bigint)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; v_path text; v_id uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  perform acl_require('media.send', p_room);

  if not exists (select 1 from rooms r where r.id = p_room) then
    raise exception '房间不存在';
  end if;
  if not exists (select 1 from rooms r where r.id = p_room and r.type = 'public')
     and not exists (select 1 from room_members mm where mm.room_id = p_room and mm.user_id = uid) then
    raise exception '不是该房间成员';
  end if;

  /* 免费版空间有限，单文件封顶 8MB */
  if coalesce(p_size, 0) > 8 * 1024 * 1024 then
    raise exception '文件超过 8MB 上限';
  end if;
  if coalesce(p_size, 0) <= 0 then raise exception '空文件'; end if;

  v_id := gen_random_uuid();
  v_path := p_room || '/' || uid::text || '/' || v_id::text;

  insert into media_objects (id, room_id, uploader, name, size, path)
  values (v_id, p_room, uid, coalesce(p_name, ''), coalesce(p_size, 0), v_path);

  perform nextval('state_rev');
  return json_build_object('id', v_id, 'path', v_path);
end;
$$;

/* storage 插入策略用：只有刚登记过的路径可写。
   security definer —— anon 只需 execute 权限，不需要直接读表。 */
create or replace function media_upload_allowed(p_path text)
returns boolean language sql stable security definer
set search_path = public, extensions, pg_temp as $$
  /* ⚠ 必须校验槽位主人（S-071）。
     原来只判 path + 未提交 + 15 分钟内 —— 不看是谁申请的。
     于是任何人只要猜到/拿到别人的 path，
     就能往别人申请的槽位里写内容，覆盖掉别人正要发的图。
     path 不是秘密，它会出现在消息体里。 */
  select exists (
    select 1 from media_objects
    where path = p_path
      and uploader = cur_user()
      and committed = false
      and created_at > now() - interval '15 minutes'
  );
$$;

/* 上传完成后提交。提交后才算数，未提交的槽位 15 分钟自动作废。 */
create or replace function media_commit(p_id uuid)
returns boolean language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  update media_objects set committed = true
   where id = p_id and uploader = uid;
  if not found then raise exception '槽位不存在或不是你申请的'; end if;
  perform nextval('state_rev');
  return true;
end;
$$;

/* 取访问链接：仍是该房间成员才给。
   桶是私有的，必须走签名 URL；签不出来就返回 null，前端退回本地。 */
create or replace function media_url(p_id uuid, p_exp int default 3600)
returns text language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; m record; v_url text;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  select * into m from media_objects where id = p_id;
  if not found then return null; end if;
  if m.uploader <> uid then
    if not exists (select 1 from rooms r where r.id = m.room_id and r.type = 'public')
       and not exists (select 1 from room_members mm
                       where mm.room_id = m.room_id and mm.user_id = uid) then
      raise exception '无权访问该媒体';
    end if;
  end if;

  v_url := null;
  begin
    /* Supabase 的 storage 扩展提供 create_signed_url；
       版本差异可能没有，异常吞掉，前端据此退回本地媒体。 */
    execute 'select storage.create_signed_url($1, $2, $3)'
      into v_url using 'media', m.path, greatest(60, least(coalesce(p_exp,3600), 86400));
  exception when others then
    v_url := null;
  end;
  return v_url;
end;
$$;

grant execute on function media_upload_allowed(text) to anon, authenticated;

-- 桶级策略：只允许登录用户读自己所在房间的媒体。
-- 没有这层，私有桶只是"默认拒绝"，仍然要靠下面的函数取签名 URL。
drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and auth_role() is not null);
/* 上传策略：不要用 `to authenticated` —— 本项目是自建会话，
   客户端拿 anon key 请求，角色永远是 anon，那条策略永远不生效，上传会全部失败。
   改成 anon 可写，但写入路径必须是服务端刚登记过的槽位。
   攻击者绕过不了：申请槽位要过门禁 + 房间成员 + media.send 权限 + 8MB 上限。 */
drop policy if exists media_write on storage.objects;
create policy media_write on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'media' and public.media_upload_allowed(name));

-- 覆盖更新（同名重传）也走同一条校验
drop policy if exists media_update on storage.objects;
create policy media_update on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'media' and public.media_upload_allowed(name))
  with check (bucket_id = 'media' and public.media_upload_allowed(name));

-- ==================================================================
-- 邀请码相关授权
--   invite_redeem 也要给 anon：邀请码的意义就是"任何人拿到都能用"，
--   身份校验在函数内部做（必须已登录 + 已过门禁），不是靠 grant 层挡。
-- ==================================================================
grant execute on function invite_create(text, int, int, text) to anon, authenticated;
grant execute on function invite_redeem(text) to anon, authenticated;
grant execute on function invite_revoke(text) to anon, authenticated;
grant execute on function invite_list() to anon, authenticated;
grant execute on function member_set_can_invite(text, uuid, boolean) to anon, authenticated;
/* ⚠ 显式授权 room_mute（S-113）。
   上面 2317 行有 `grant execute on all functions`，
   但那条**只授予执行到它那一刻已存在的函数** ——
   之后新建的函数不会被自动覆盖，漏了就报 permission denied。
   而且签名必须写全：room_mute(text, uuid, int)，
   写成 room_mute(text) 会建出一个**不存在的重载的授权**，静默无效。 */
/* ============================================================
   站点保护密码开关（Q-Chat-S-120）
   ────────────────────────────────────────────────────────────
   取消保护密码后，站点对所有人开放读取，但**账号验证仍在**：
   msg_send / room_create 等一律要求 cur_user() 非空。
   所以这不是"站点裸奔"，而是"去掉进站那道额外的门"。

   ⚠ 只允许站长（owner）操作，且必须已登录。
     这是不可逆感很强的操作 —— 虽然留了 gate_enable 退路，
     但清空的是 bcrypt 哈希，**旧密码本身找不回来**，
     重新开门必须设一个新密码。
============================================================ */
create or replace function gate_disable()
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (select 1 from users where id = uid and role = 'owner') then
    raise exception '仅站长可取消保护密码';
  end if;
  if not exists (select 1 from site where id = true and (gate_hash is not null or gate_disabled)) then
    raise exception '站点尚未初始化';
  end if;

  update site set
    gate_hash = null,
    gate_prev_hash = null,
    gate_new_enc = null,
    gate_grace = 0,
    gate_disabled = true
  where id = true;

  insert into logs (who_id, act, detail) values (uid, 'gate_disable', '取消站点保护密码，改为开放访问（账号验证仍在）');
  return json_build_object('ok', true);
end;
$$;

/* 重新设置保护密码（退路）。
   取消不是单向的：随时可以再设一个回来。
   ⚠ 但旧密码无法恢复 —— 存的是 bcrypt 哈希，清空即永久丢失。 */
create or replace function gate_enable(p text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  uid := cur_user();
  if uid is null then raise exception '请先登录'; end if;
  if not exists (select 1 from users where id = uid and role = 'owner') then
    raise exception '仅站长可设置保护密码';
  end if;
  if coalesce(length(p), 0) < 4 then raise exception '保护密码至少 4 位'; end if;

  update site set
    gate_hash = crypt(p, gen_salt('bf', 10)),
    gate_prev_hash = null,
    gate_new_enc = null,
    gate_grace = 0,
    gate_disabled = false
  where id = true;

  insert into logs (who_id, act, detail) values (uid, 'gate_enable', '重新启用站点保护密码');
  return json_build_object('ok', true);
end;
$$;

grant execute on function gate_disable() to anon, authenticated;
grant execute on function gate_enable(text) to anon, authenticated;

/* ================================================================
   whoami() —— 跨项目统一账号的读取端（Q-Site-S-121）

   用途：个人主页（liuyiming2024.github.io）要在导航条上显示
   "当前是谁 · 什么角色 · 退出登录"，但它是一个纯静态页，
   不能把 state_get() 的全量状态拉下来（那是为聊天室设计的，
   包含房间、消息、成员，几十 KB 起，主页只要一行身份）。

   ⚠ 为什么返回 {ok:false} 而不是 raise exception：
     主页每次加载都会调它，未登录是**正常状态**而不是错误。
     抛异常会让浏览器控制台飘红，也会让调用方必须写 try/catch，
     把"没登录"和"网络断了"混成一谈。

   ⚠ 不返回 real_name（沿用 user_login 的约定）：
     实名不随任何响应外泄，连本人也不通过这种方式拿。

   ⚠ 不返回权限清单：主页只需要显示角色名。
     权限判定一律走服务端各函数体内的 if ... raise，
     前端拿到的清单只用于"要不要显示这个按钮"，不参与安全判定。
=============================================================== */
create or replace function whoami()
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; u record;
begin
  uid := cur_user();
  if uid is null then
    return json_build_object('ok', false, 'err', 'not logged in');
  end if;

  select id, nick, role, status into u from users where id = uid;
  if u.id is null then
    /* 会话有效但用户没了（被物理删除）。
       ⚠ 这种情况必须报 ok:false 并让前端清掉会话 ——
         否则前端会一直拿着一个死 token，界面显示"已登录"而什么都做不了。 */
    return json_build_object('ok', false, 'err', 'user gone');
  end if;

  return json_build_object(
    'ok', true,
    'id', u.id,
    'nick', u.nick,
    'role', u.role,
    'status', u.status,
    'site', (select site_name from site where id = true)
  );
end;
$$;

grant execute on function whoami() to anon, authenticated;

/* ================================================================
   user_list() —— 用户列表（Q-Chat-S-123）

   用途：集群层的账号设置页 / 审核页要列出用户。
   为什么不能沿用 state_get()：那个是为聊天室设计的全量状态，
   包含房间、消息、成员，几十 KB 起；而主页只要几行用户。
   在门面页拉全量状态，既慢又把聊天室的数据结构暴露到别的页面。

   ⚠ 权限：成员只能拿到自己那一行；管理员/站长才能拿全部。
     这不是"前端不显示"就行 —— 这里就是闸门本身。
     昵称、申请说明（real_name）都是个人信息，不能谁都能列。

   ⚠ 不返回 pwd_hash / 会话信息。
=============================================================== */
create or replace function user_list(p_status text default null)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; isadmin boolean;
begin
  uid := cur_user();
  if uid is null then
    return json_build_object('ok', false, 'err', 'not logged in');
  end if;

  select exists(select 1 from users u where u.id = uid and u.role in ('owner','admin'))
    into isadmin;

  /* ⚠⚠ Q-Chat-S-133：`order by` **必须写在子查询里**，不能直接跟在聚合的 FROM 后。

     原来写成 `select json_agg(...) from users u ... order by u.created_at desc`：
     json_agg 是聚合函数，order by 直接跟在 FROM 后会被当成**窗口排序**，
     于是 u.created_at 既不在 GROUP BY 里、也不在聚合里 →
       ERROR: column "u.created_at" must appear in the GROUP BY clause

     ★ **这不是理论问题，是实测出来的真故障**：
       站长点开「审核队列」时这个函数**每次调用都抛异常**，
       即"注册审核"这个功能是**完全不可用的** —— 队列永远空白，
       新用户注册后站长根本看不到、也就永远过不了审。
       （而且表现是"空白"而不是"报错"，前端拿到异常后不渲染，
         站长只会以为"没人注册"。）

     ⚠ 这是本仓库第 4 次踩同一个坑：
       S-129 的 api_entry_list / api_note_list / api_summary_list 三个函数，
       当时就知道"要用子查询排序"，**却没回头检查别处是否也有同样写法** ——
       而 user_list 恰恰就是当时漏掉的那个。
       **修好一处不等于同类都好了，必须全库再查一遍。**

     修法：把排序移到内层子查询，外层只做聚合。 */
  return json_build_object('ok', true, 'users', coalesce((
    select json_agg(t.j) from (
      select json_build_object(
        'id', u.id,
        'nick', u.nick,
        'role', u.role,
        'status', u.status,
        'bio', u.bio,
        'avatar', u.avatar,
        'createdAt', (extract(epoch from u.created_at) * 1000)::bigint,
        /* ⚠ real_name（申请说明）**只对管理员返回**。
           普通成员列用户时拿到别人的申请理由，那是信息泄露 ——
           理由里常有真实姓名、班级。 */
        'note', case when isadmin then u.real_name else null end
      ) as j
      from users u
      where (isadmin or u.id = uid)
        and (p_status is null or u.status = p_status)
      order by u.created_at desc
    ) t
  ), '[]'::json));
end;
$$;

grant execute on function user_list(text) to anon, authenticated;

grant execute on function room_mute(text, uuid, int) to anon, authenticated;

/* ==================================================================
   Q-Chat-S-136：函数权限改**白名单**（外部报告 C-4 / V-03）

   ⚠⚠ 删掉了这一行：
       grant execute on all functions in schema public to anon, authenticated;

   它的问题不是"现在就被利用了"，而是**默认开放**：
   任何一个新函数，只要忘了加校验，立刻对全网匿名可调用。
   报告里"58 个 SECURITY DEFINER 全部对匿名可执行"正是这个意思。
   我上轮审计的结论是"那 58 个都有校验、实测全是误报"——
   **但这只说明"今天没出事"，不说明"明天不会出事"**。
   默认开放 + 靠每次记得加校验 = 迟早漏一个。

   ★ 改成白名单后：新函数**默认不可调用**，必须显式加一行才开放。
     漏写的后果从"悄悄开放"变成"功能报错"——后者会被立刻发现。
     这是把"静默失败"换成"吵闹失败"，方向是对的。

   ⚠⚠ 关键认知（我一开始想错了）：
      **删掉 grant 语句不会撤销已经授予的权限。**
      PostgreSQL 的 grant 是持久 DDL，权限记在函数 ACL 里。
      只删那一行，之前靠它拿到权限的 58 个函数**照样能被调用**。
      所以必须显式 revoke —— 这一步不能省。

   ⚠ 为什么不写 `revoke execute on all functions ...`：
      本库是 Chat 与 Archive **共库**，那样会连 Archive 的 37 个函数一起回收
      （api_* / draft_* / profile_* 全在其中），档案接口直接全挂。
      所以这里**逐个精确 revoke**，只动 Chat 自己定义的那些。
      跨项目的全局语句在这个架构下就是地雷。

   ⚠ 白名单来源：rpc-wiring 扫出的前端实际调用（54 个）+ 原有显式 grant。
     不是"我觉得该开放哪些"，是"实际在调哪些"——
     凭感觉列白名单一定会漏，漏一个就是某个功能突然 401。

   ⚠ SECURITY DEFINER 函数内部调用**不受影响**：
     它们以 owner 身份执行，不需要给 anon 授权。
     所以 cur_user / auth_uid 这批内部件可以放心 revoke。

   ⚠ 将来新增函数：必须在本文件里补一行 grant，否则前端调用会 401。
     这是故意的摩擦 —— 宁可多写一行，不要默认开放。
================================================================== */

do $wl$
declare
  stmts text[] := array[
    'revoke execute on function acl_aggregate(text) from anon, authenticated',
    'revoke execute on function acl_can_speak(text) from anon, authenticated',
    'revoke execute on function acl_role_perms(text) from anon, authenticated',
    'revoke execute on function acl_room_inherent() from anon, authenticated',
    'revoke execute on function acl_room_role(text) from anon, authenticated',
    'revoke execute on function auth_is_staff() from anon, authenticated',
    'revoke execute on function auth_require() from anon, authenticated',
    'revoke execute on function auth_role() from anon, authenticated',
    'revoke execute on function auth_uid() from anon, authenticated',
    'revoke execute on function cur_token() from anon, authenticated',
    'revoke execute on function cur_token_hash() from anon, authenticated',
    'revoke execute on function cur_user() from anon, authenticated',
    'revoke execute on function gate_passed() from anon, authenticated',
    'revoke execute on function issue_session(uuid,boolean) from anon, authenticated',
    'revoke execute on function login_attempts_cleanup() from anon, authenticated',
    'revoke execute on function msg_rev_bump() from anon, authenticated',
    'revoke execute on function new_token() from anon, authenticated',
    'revoke execute on function self_guard(uuid,text) from anon, authenticated',
  ];
  s text;
begin
  foreach s in array stmts loop
    begin
      execute s;
    exception when others then
      /* ⚠ 缺哪个函数都不能让整份 schema 挂掉 ——
         线上若还没跑到那一步，revoke 会报 undefined function。
         但**必须报出来**，否则以后真漏了也没人知道。 */
      raise notice 'S-136 跳过（函数可能不存在）：%', s;
    end;
  end loop;
end $wl$;

/* 白名单：以下是对 anon/authenticated 开放的全部函数。

   ⚠⚠ 为什么这些 grant 放进 do 块而不是直接执行（S-136 踩坑）：
      第一版写成裸语句，结果**整份迁移直接失败** ——
      只要有一条函数签名与线上不一致（比如线上还是旧签名），
      `grant execute on function xxx(...)` 就抛 undefined function，
      而一条报错会中断整份 schema。

      后果很糟：为了收紧权限，反而把整个数据库迁移搞挂了。
      收紧安全边界的操作**必须比业务代码更容错** ——
      它失败的方向不能是"全站不可用"。

      放进 do 块 + notice：签名对不上只跳过这一条并报出来，
      其余照常执行。跳过哪些我能在日志里看见，再回来修签名。 */
do $wl2$
declare
  stmts text[] := array[
    'grant execute on function acl_can(text,text,uuid) to anon, authenticated;',
    'grant execute on function acl_mine(text) to anon, authenticated;',
    'grant execute on function acl_perms_list() to anon, authenticated;',
    'grant execute on function acl_require(text,text,uuid) to anon, authenticated;',
    'grant execute on function acl_why(text,text,uuid) to anon, authenticated;',
    'grant execute on function bridge_ticket_create(text) to anon, authenticated;',
    'grant execute on function bridge_ticket_redeem(text,text) to anon, authenticated;',
    'grant execute on function gate_check(text) to anon, authenticated;',
    'grant execute on function gate_disable() to anon, authenticated;',
    'grant execute on function gate_enable(text) to anon, authenticated;',
    'grant execute on function gate_set(text,text) to anon, authenticated;',
    'grant execute on function invite_create(text,int,int,text) to anon, authenticated;',
    'grant execute on function invite_list() to anon, authenticated;',
    'grant execute on function invite_redeem(text) to anon, authenticated;',
    'grant execute on function invite_revoke(text) to anon, authenticated;',
    'grant execute on function logout() to anon, authenticated;',
    'grant execute on function media_commit(uuid) to anon, authenticated;',
    'grant execute on function media_prepare(text,text,bigint) to anon, authenticated;',
    'grant execute on function media_upload_allowed(text) to anon, authenticated;',
    'grant execute on function media_url(uuid,int) to anon, authenticated;',
    'grant execute on function media_url_by_path(text) to anon, authenticated;',
    'grant execute on function member_add(text,uuid) to anon, authenticated;',
    'grant execute on function member_admin(text,uuid,boolean) to anon, authenticated;',
    'grant execute on function member_remove(text,uuid) to anon, authenticated;',
    'grant execute on function member_set_can_invite(text,uuid,boolean) to anon, authenticated;',
    'grant execute on function msg_delete(uuid) to anon, authenticated;',
    'grant execute on function msg_edit(uuid,text) to anon, authenticated;',
    'grant execute on function msg_media(uuid,text) to anon, authenticated;',
    'grant execute on function msg_send(text,text,text,text,text,bigint,uuid) to anon, authenticated;',
    'grant execute on function profile_update(text,text,text,text) to anon, authenticated;',
    'grant execute on function room_create(text,text,text) to anon, authenticated;',
    'grant execute on function room_delete(text) to anon, authenticated;',
    'grant execute on function room_dm(uuid) to anon, authenticated;',
    'grant execute on function room_join(text,text) to anon, authenticated;',
    'grant execute on function room_leave(text) to anon, authenticated;',
    'grant execute on function room_mute(text,uuid,int) to anon, authenticated;',
    'grant execute on function room_update(text,text,text,text,text) to anon, authenticated;',
    'grant execute on function session_cleanup() to anon, authenticated;',
    'grant execute on function site_info() to anon, authenticated;',
    'grant execute on function site_init(text,text,text,text) to anon, authenticated;',
    'grant execute on function site_ready() to anon, authenticated;',
    'grant execute on function site_set(text,boolean) to anon, authenticated;',
    'grant execute on function state_delta(bigint) to anon, authenticated;',
    'grant execute on function state_get() to anon, authenticated;',
    'grant execute on function state_peek() to anon, authenticated;',
    'grant execute on function state_seq() to anon, authenticated;',
    'grant execute on function user_delete(uuid) to anon, authenticated;',
    'grant execute on function user_list(text) to anon, authenticated;',
    'grant execute on function user_login(text,text) to anon, authenticated;',
    'grant execute on function user_mute(uuid,int) to anon, authenticated;',
    'grant execute on function user_password(text,text) to anon, authenticated;',
    'grant execute on function user_perms_set(uuid,text[],text[]) to anon, authenticated;',
    'grant execute on function user_register(text,text,text) to anon, authenticated;',
    'grant execute on function user_review(uuid,text) to anon, authenticated;',
    'grant execute on function user_role_set(uuid,text) to anon, authenticated;',
    'grant execute on function user_self_unban() to anon, authenticated;',
    'grant execute on function whoami() to anon, authenticated;',
  ];
  s text;
begin
  foreach s in array stmts loop
    begin
      execute s;
    exception when others then
      raise notice 'S-136 跳过（签名可能不符）：%', s;
    end;
  end loop;
end $wl2$;