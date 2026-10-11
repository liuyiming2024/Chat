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

-- ---------- 行为验证 ----------
do $$
declare mid uuid := 'a546fbcc-f170-400b-adbe-f144396c490e';
begin
  insert into media_objects (room_id, uploader, name, size, path, committed, created_at)
    values ('public', null, 'probe-old.png', 1024, 'public/probe/old.png', false,
            now() - interval '48 hours');
  insert into media_objects (room_id, uploader, name, size, path, committed)
    values ('public', null, 'probe-new.png', 1024, 'public/probe/new.png', false);
  perform session_cleanup();
  raise notice 'S-009 旧未提交还剩=%（应 0）',
    (select count(*) from media_objects where path='public/probe/old.png');
  raise notice 'S-009 新未提交还剩=%（应 1）',
    (select count(*) from media_objects where path='public/probe/new.png');
  delete from media_objects where path like 'public/probe/%';
end $$;
