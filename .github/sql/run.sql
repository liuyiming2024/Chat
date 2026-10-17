/* 实测：匿名调用这些函数，看会不会泄露数据 */
begin;
do $$
declare r json; t text;
begin
  raise notice '① cur_user()=%  gate_passed()=%', cur_user(), gate_passed();

  begin select code_me() into r; raise notice '② code_me → %', left(r::text,120);
  exception when others then raise notice '② code_me 被拒：%', SQLERRM; end;

  begin select forum_list() into r; raise notice '③ forum_list → %', left(coalesce(r::text,'NULL'),120);
  exception when others then raise notice '③ forum_list 被拒：%', SQLERRM; end;

  begin select media_upload_allowed('x/y.png') into r; raise notice '④ media_upload_allowed → %', coalesce(r::text,'NULL');
  exception when others then raise notice '④ media_upload_allowed 被拒：%', SQLERRM; end;

  begin select bridge_ticket_redeem('fake','x') into r; raise notice '⑤ bridge_ticket_redeem → %', coalesce(r::text,'NULL');
  exception when others then raise notice '⑤ bridge_ticket_redeem 被拒：%', SQLERRM; end;

  begin select site_can_nick('站长') into r; raise notice '⑥ site_can_nick → %', coalesce(r::text,'NULL');
  exception when others then raise notice '⑥ site_can_nick 被拒：%', SQLERRM; end;

  begin select user_list() into r; raise notice '⑦ user_list → %', left(coalesce(r::text,'NULL'),100);
  exception when others then raise notice '⑦ user_list 被拒：%', SQLERRM; end;

  begin select whoami() into r; raise notice '⑧ whoami → %', coalesce(r::text,'NULL');
  exception when others then raise notice '⑧ whoami 被拒：%', SQLERRM; end;

  begin select acl_perms_list() into r; raise notice '⑨ acl_perms_list → %', left(coalesce(r::text,'NULL'),100);
  exception when others then raise notice '⑨ acl_perms_list 被拒：%', SQLERRM; end;
end $$;
rollback;
