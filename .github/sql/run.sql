/* 清空使用期数据（提出人："这些站都还没有投入使用，以前的数据都不用了"）
   ⚠ 只清"用出来的数据"，不动"配置出来的元数据"：
     保留 acl_perm_label / site_perms / site / users —— 那是规则不是流水。
     清错了规则，站会直接不能跑；清错了流水，最多少几条记录。 */
begin;
do $$
declare n int; r record;
begin
  for r in select unnest(array['messages','media_objects','invites',
                               'bridge_ticket','drafts','login_attempts','logs']) as t
  loop
    begin
      execute format('delete from %I', r.t);
      get diagnostics n = row_count;
      raise notice '  清 % = % 行', r.t, n;
    exception when others then
      raise notice '  跳过 %（%）', r.t, SQLERRM;
    end;
  end loop;
end $$;

/* rooms 单独看：默认房间保留还是清，先看它叫什么 */
do $$
declare r record;
begin
  for r in select id, name, type,
                  (select count(*) from messages m where m.room_id = rooms.id) as msgs
             from rooms
  loop
    raise notice '  房间「%」类型=% 消息数=%', r.name, r.type, r.msgs;
  end loop;
end $$;
rollback;

/* 先不删房间：清掉的话用户进来一个房间都没有，得自己建。
   等提出人确认要清再说 —— **删数据是不可逆的，宁可多问一次**。 */
