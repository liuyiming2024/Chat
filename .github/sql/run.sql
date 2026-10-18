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