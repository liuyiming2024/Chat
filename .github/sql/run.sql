-- 临时：落地自定义口令服务端改动（用完即清）
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

grant execute on function invite_create(text, int, int, text) to anon, authenticated;

grant execute on function invite_list() to anon, authenticated;