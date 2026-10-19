/* S-142 补验：R4-04 必须用**真实 owner 会话**才验得到长度检查。
   上一轮报"请先登录"说明没验到 —— 那时 db-run 用的是 postgres 角色，
   压根没走到 length 那一行。断言报绿但验的是别的东西，等于没验。

   做法：签一个站长会话 → 用 set_config 伪造 request.headers 里的 x-session
   （cur_token() 就是读这个）→ 再调 gate_enable。 */
begin;
update site set gate_disabled=true where id=true;
update users set status='active' where role='owner';

do $$
declare tk text; msg text;
begin
  tk := issue_session((select id from users where role='owner' limit 1), false);
  perform set_config('request.headers',
                     json_build_object('x-session', tk)::text, true);

  /* ① 4 位 → 应被拒（提示"至少 8 位"） */
  begin
    perform gate_enable('1234');
    raise notice '❌ 4 位被接受 —— 服务端没守住';
  exception when others then
    raise notice '① 4 位：%', SQLERRM;
  end;

  /* ② 7 位 → 应被拒 */
  begin
    perform gate_enable('1234567');
    raise notice '❌ 7 位被接受';
  exception when others then
    raise notice '② 7 位：%', SQLERRM;
  end;

  /* ③ 8 位 → 应接受（阈值判断准确，不是永远拒绝） */
  begin
    perform gate_enable('12345678');
    raise notice '③ 8 位：✅ 已接受';
  exception when others then
    raise notice '❌ 8 位也被拒：% —— 闸门过严', SQLERRM;
  end;
end $$;
rollback;

/* R4-05：确认 user_login 的全局计数加了 kind 过滤 */
select count(*) as 含kind过滤的语句数 from (
  select 1 from pg_proc p
   where p.proname='user_login'
     and pg_get_functiondef(p.oid) like '%kind = ''login''%') t;
