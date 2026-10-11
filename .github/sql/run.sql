alter table room_members add column if not exists can_invite boolean not null default true;

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

create or replace function invite_create(p_room text, p_hours int default 24, p_max_use int default 5)
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

  /* 生成 6 位口令，避开易混淆字符（0/O、1/I/L） */
  <<gen>>
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
                                 1 + floor(random() * 31)::int, 1);
    end loop;
    exit gen when not exists (select 1 from invites where code = v_code);
  end loop;

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

  select * into v from invites
   where code = upper(btrim(coalesce(p_code,''))) for update;

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
  select * into v from invites where code = upper(btrim(coalesce(p_code,'')));
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

-- ---------- 行为验证 ----------
\echo '=== invites 表 ==='
select count(*) as invites_table from information_schema.tables
 where table_name='invites';
\echo '=== can_invite 列 ==='
select count(*) as can_invite_col from information_schema.columns
 where table_name='room_members' and column_name='can_invite';
\echo '=== 四个函数 ==='
select proname from pg_proc where proname like 'invite_%' or proname='member_set_can_invite' order by proname;
