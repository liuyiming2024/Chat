-- ==================================================================
-- Code · 云盘（接同一个 Supabase、同一套账号）
--
-- ⚠ 本文件有【两份】，改任何一份都要同步另一份：
--     1. Code 仓库：code/supabase/cloud.sql        （源码所在地，供阅读与版本追溯）
--     2. Chat 仓库：.github/sql/code-cloud.sql     （实际执行的那份）
--   执行走 Chat 那边，因为 Code 仓库的 SUPABASE_DB_URL Secret 密码已失效。
--
--   全部语句幂等（create table if not exists / create or replace），
--   重复执行安全 —— 这也是"放那边跑"能成立的前提。
--
-- 前提：本脚本只建 Code 自己的部分，不碰 Chat 已有的表与函数。
--       账号、会话、门禁全部复用 public.users / sessions / site。
--
-- 鉴权口径与 Chat 完全一致：
--   1. 必须已登录（auth_require → cur_user 不为空）。**这一条才是真正的门槛**
--   2. 同时要求 gate_passed()。要如实说明：gate_passed 对"已绑定账号的会话"
--      恒为 true（它的定义是 gate_ok or user_id is not null），
--      所以已登录时这道校验不会额外拦人 —— 保留它是为了口径与 Chat 一致，
--      不要把它当成第二道独立防线，也不要据此认为"没过保护密码就进不来"。
--   3. 一切以 cur_user() 为准，绝不信任前端传来的 user_id
--
-- 为什么每个函数都要 security definer + search_path：
--   definer 让函数以属主权限读 sessions（否则查不到当前身份）；
--   search_path 钉死是为了防止有人在可写 schema 里埋同名函数劫持。
-- ==================================================================

-- ---------- 表 ----------
create table if not exists code_files (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  path        text not null,
  content     text not null default '',
  size        int  not null default 0,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (user_id, path)
);

create index if not exists code_files_user_idx on code_files (user_id);

-- ---------- 常量：配额 ----------
-- Supabase 免费版数据库 500 MB，这里给每人 50 MB 上限。
-- 单文件 2 MB：超过这个量级的代码文件在浏览器里编辑本来就会卡，
-- 与其让它存上去再卡死，不如在入口拦住。
-- 文件数 2000：防止有人用大量空文件刷行数。

-- ---------- 路径规范化 ----------
-- 三件事：
--   1. 统一成 / 开头、不含末尾斜杠
--   2. 干掉 ../ 与 ./ —— 否则前端传 ../../etc/passwd 会写出去（虽然这里
--      只是数据库里的一列，但脏路径会让"按目录分组"等功能出错）
--   3. 挡掉空路径与超长路径
create or replace function code_path_norm(p_path text)
returns text language plpgsql immutable
set search_path = public, extensions, pg_temp as $$
declare s text; parts text[]; out text[]; seg text;
begin
  s := coalesce(p_path, '');
  s := replace(s, '\', '/');
  if s = '' then return null; end if;

  parts := string_to_array(s, '/');
  out := '{}';
  foreach seg in array parts loop
    if seg = '' or seg = '.' then
      continue;
    elsif seg = '..' then
      if array_length(out, 1) > 0 then
        out := out[1 : array_length(out, 1) - 1];
      end if;
    else
      out := out || seg;
    end if;
  end loop;

  if array_length(out, 1) is null then return null; end if;
  s := array_to_string(out, '/');
  if length(s) > 400 then return null; end if;
  return s;
end;
$$;


-- ---------- 当前用户与配额 ----------
create or replace function code_me()
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; u record; used bigint; cnt int;
begin
  uid := cur_user();
  if uid is null then return json_build_object('ok', false, 'err', '未登录'); end if;

  select * into u from users where id = uid;
  if not found then return json_build_object('ok', false, 'err', '账号不存在'); end if;

  select coalesce(sum(size), 0), count(*) into used, cnt
  from code_files where user_id = uid;

  return json_build_object(
    'ok', true,
    'uid', uid,
    'nick', u.nick,
    'role', u.role,
    'gate', gate_passed(),
    'used', used,
    'files', cnt,
    'quota', 52428800,          -- 50 MB
    'maxFile', 2097152          -- 单文件 2 MB
  );
end;
$$;


-- ---------- 列目录 ----------
-- 只返回路径、大小、时间，不返回内容 ——
-- 列表接口带内容会让"打开文件树"变成一次全量下载。
create or replace function code_file_list()
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid;
begin
  uid := auth_require();
  perform code_gate_require();

  return coalesce((
    select json_agg(json_build_object(
             'path', f.path, 'size', f.size, 'updated_at', f.updated_at
           ) order by f.path)
    from code_files f where f.user_id = uid
  ), '[]'::json);
end;
$$;


-- ---------- 读取单个文件 ----------
create or replace function code_file_get(p_path text)
returns json language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; p text; f record;
begin
  uid := auth_require();
  perform code_gate_require();
  p := code_path_norm(p_path);
  if p is null then return json_build_object('ok', false, 'err', '路径无效'); end if;

  select * into f from code_files where user_id = uid and path = p;
  if not found then return json_build_object('ok', false, 'err', '文件不存在'); end if;

  return json_build_object('ok', true, 'path', f.path, 'content', f.content,
                           'size', f.size, 'updated_at', f.updated_at);
end;
$$;


-- ---------- 保存 ----------
create or replace function code_file_save(p_path text, p_content text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; p text; len int; used bigint; cnt int;
begin
  uid := auth_require();
  perform code_gate_require();
  p := code_path_norm(p_path);
  if p is null then return json_build_object('ok', false, 'err', '路径无效'); end if;

  len := octet_length(coalesce(p_content, ''));
  if len > 2097152 then
    return json_build_object('ok', false, 'err', '单文件超过 2 MB');
  end if;

  select coalesce(sum(size), 0), count(*) into used, cnt
  from code_files where user_id = uid;

  -- 新文件才检查数量；更新旧文件不占新名额
  if not exists (select 1 from code_files where user_id = uid and path = p) then
    if cnt >= 2000 then
      return json_build_object('ok', false, 'err', '文件数已达上限 2000');
    end if;
    if used + len > 52428800 then
      return json_build_object('ok', false, 'err', '云盘空间不足（上限 50 MB）');
    end if;
  else
    if used - (select size from code_files where user_id = uid and path = p) + len > 52428800 then
      return json_build_object('ok', false, 'err', '云盘空间不足（上限 50 MB）');
    end if;
  end if;

  insert into code_files (user_id, path, content, size, updated_at)
  values (uid, p, coalesce(p_content, ''), len, now())
  on conflict (user_id, path) do update
    set content = excluded.content, size = excluded.size, updated_at = now();

  return json_build_object('ok', true, 'path', p, 'size', len);
end;
$$;


-- ---------- 删除 ----------
create or replace function code_file_delete(p_path text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; p text;
begin
  uid := auth_require();
  perform code_gate_require();
  p := code_path_norm(p_path);
  if p is null then return json_build_object('ok', false, 'err', '路径无效'); end if;

  delete from code_files where user_id = uid and path = p;
  return json_build_object('ok', true, 'path', p);
end;
$$;


-- ---------- 清空云盘（危险，需显式确认） ----------
create or replace function code_cloud_reset(p_confirm text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare uid uuid; n int;
begin
  uid := auth_require();
  perform code_gate_require();
  if p_confirm <> 'DELETE' then
    return json_build_object('ok', false, 'err', '请传入确认词 DELETE');
  end if;

  delete from code_files where user_id = uid;
  get diagnostics n = row_count;
  return json_build_object('ok', true, 'deleted', n);
end;
$$;


-- ---------- 门禁校验（供上面各函数调用） ----------
-- 单独抽出来：所有接口都要过，写一处比在六个函数里各写一遍可靠。
-- 不放进 auth_require 是因为那是 Chat 的公共函数，改它会影响聊天室。
--
-- 关于 gate_passed() 的实情（本地回归验证过）：
--   对"已绑定账号的会话"它恒为 true，所以它拦不住已登录用户 —— 这是设计，
--   不是漏洞。真正拦未授权访问的是 auth_require() 要求的登录态。
--   别在这里加码，也别在文档里把它写成第二道防线。
create or replace function code_gate_require()
returns void language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
begin
  if cur_user() is null then raise exception '请先登录'; end if;
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;
end;
$$;


-- ---------- 权限 ----------
-- PostgREST 以 anon / authenticated 角色调用，必须显式授权，
-- 否则函数存在但调不通，报的是 404 而不是权限错误（很难查）。
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on code_files to authenticated;
revoke all on code_files from anon;
grant execute on function code_path_norm(text) to anon, authenticated;
grant execute on function code_me() to anon, authenticated;
grant execute on function code_file_list() to anon, authenticated;
grant execute on function code_file_get(text) to anon, authenticated;
grant execute on function code_file_save(text, text) to anon, authenticated;
grant execute on function code_file_delete(text) to anon, authenticated;
grant execute on function code_cloud_reset(text) to anon, authenticated;
grant execute on function code_gate_require() to anon, authenticated;
