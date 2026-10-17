do $$
declare r record;
begin
  for r in select id, name, type, owner_id,
                  (select count(*) from room_members m where m.room_id=rooms.id) as mem,
                  (select count(*) from room_admins a where a.room_id=rooms.id) as adm,
                  (select count(*) from messages g where g.room_id=rooms.id) as msg,
                  (select count(*) from messages g where g.room_id=rooms.id and g.deleted) as del
             from rooms
  loop
    raise notice '「%」type=% owner=%s 成员=% 管理员=% 消息=%(其中已撤回 %)',
      r.name, r.type, coalesce(r.owner_id::text,'(无/系统)'), r.mem, r.adm, r.msg, r.del;
  end loop;
  raise notice '---';
  raise notice '用户数=%  待审核=%  被拒=%',
    (select count(*) from users),
    (select count(*) from users where status='pending'),
    (select count(*) from users where status='denied');
  raise notice '会话=%  邀请=%  媒体=%  草稿=%',
    (select count(*) from sessions), (select count(*) from invites),
    (select count(*) from media_objects), (select count(*) from drafts);
end $$;
