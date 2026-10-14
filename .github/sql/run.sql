-- 临时语法探针（用完即清）：只读事务里，语法错误在解析阶段报出，
-- 只读限制在执行阶段报出。据此区分"我的 SQL 写错了"和"只是没权限写"。
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