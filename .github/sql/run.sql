/* Q-Chat-S-120：正式取消站点保护密码。
   等效于以站长身份调 gate_disable()（迁移通道本身就是最高权限），
   同时补一条审计日志，便于以后查"是谁在什么时候拆的门"。 */
update site set
  gate_hash = null,
  gate_prev_hash = null,
  gate_new_enc = null,
  gate_grace = 0,
  gate_disabled = true
where id = true;

insert into logs (who_id, act, detail)
select u.id, 'gate_disable', '取消站点保护密码，改为开放访问（账号验证仍在）'
from users u where u.role = 'owner' limit 1;

do $$
declare st record; tk text; r jsonb; uid uuid;
begin
  select * into st from site where id = true;
  raise notice '① 已取消？gate_disabled = %  gate_hash 为空 = %',
    st.gate_disabled, (st.gate_hash is null);

  raise notice '② site_ready() = %（必须 true，否则前端会以为未初始化、弹出建站页）', site_ready();
  raise notice '③ gate_passed()（无会话） = %（无门应为 true）', gate_passed();

  -- 无门时拿只读会话
  r := gate_check('')::jsonb;
  tk := r->>'token';
  raise notice '④ gate_check(空密码) 拿到会话 = %', (tk is not null and length(tk) > 0);

  raise notice '⑤ 这个会话是匿名的：cur_user() = %（应为 <NULL>）',
    coalesce((select cur_user())::text, '<NULL>');

  -- 关键：账号门必须还在
  begin
    perform msg_send('public', 'text', '未登录尝试发言', null, null, null, null);
    raise notice '⑥ ✗ 未登录居然能发消息 —— 账号门失效了！';
  exception when others then
    raise notice '⑥ ✓ 未登录发消息被拒：%', SQLERRM;
  end;

  select id into uid from users where role='owner' limit 1;
  raise notice '⑦ 站长仍在，role=owner 的人数 = %',
    (select count(*) from users where role='owner');

  raise notice '⑧ state_get 返回 gate_off = %',
    (state_get()::jsonb->'site')->>'gate_off';
end $$;
