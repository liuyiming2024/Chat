create or replace function user_login(p_nick text, p_pwd text)
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare u record; tk text; v_fail int;
begin
  if not gate_passed() then raise exception '请先通过站点保护密码'; end if;

  /* 频率闸门：15 分钟内同一昵称失败 8 次即冻结 15 分钟。
     这是数据库层唯一能做的登录限流位置。

     ⚠ 只按昵称计数是不够的（S-008）：换一个昵称就绕过了，
     而且任何人知道你昵称、试错 8 次就能把你锁 15 分钟。
     所以下面还有一道全局闸门。 */
  select count(*) into v_fail from login_attempts
   where lower(nick) = lower(p_nick) and ok = false
     and created_at > now() - interval '15 minutes';
  if v_fail >= 8 then
    return json_build_object('ok', false, 'err', '尝试次数过多，请 15 分钟后再试');
  end if;

  /* 全局闸门：15 分钟内全站失败 ≥ 100 次就整体拒绝。
     这是"换昵称爆破"唯一拦得住的地方 —— 昵称维度对它是无效的。

     为什么不用 IP 做第二维度：
       · 请求头里的 x-forwarded-for 客户端自己能改，等于没有
       · 同一个 NAT 后面可能是一整个学校/公司，按 IP 限流会误伤一大片
     所以宁可粗一点用全局闸门。100 次/15 分钟对正常站点很宽松，
     正常用户极少失败这么多次；真被爆破时宁可暂时全站挡住。 */
  select count(*) into v_fail from login_attempts
   where ok = false and created_at > now() - interval '15 minutes';
  if v_fail >= 100 then
    return json_build_object('ok', false, 'err', '登录尝试过于频繁，请稍后再试');
  end if;

  select * into u from users where lower(nick) = lower(p_nick);
  if not found then
    insert into login_attempts (nick, ok) values (p_nick, false);
    /* ⚠ 这里原来有一句 perform nextval('state_rev')（S-006）。
       登录失败跟状态变更毫无关系，却会让每次失败都推进全局序号，
       惊动所有在线客户端去拉一次增量 ——
       1 次爆破请求被放大成 N 次拉取，等于给了攻击者一个免费放大器。
       删掉。 */
    return json_build_object('ok', false, 'err', '昵称或密码错误');
  end if;

  if u.pwd_hash <> crypt(p_pwd, u.pwd_hash) then
    insert into login_attempts (nick, ok) values (p_nick, false);
    /* 同上：失败不推进全局序号 */
    return json_build_object('ok', false, 'err', '昵称或密码错误');
  end if;

  -- 密码正确，再判状态（顺序不能反：否则能凭报错枚举"昵称是否存在/是否被封"）
  if u.status = 'banned' then
    return json_build_object('ok', false, 'err', '该账号已被封禁');
  end if;
  if u.status = 'pending' then
    return json_build_object('ok', false, 'err', '账号待站长审核，请稍候');
  end if;

  insert into login_attempts (nick, ok) values (p_nick, true);
  /* 登录成功：只清这个昵称自己的旧失败记录（好让计数重新开始）。
     ⚠ 全表清理不在这里做 —— 放在 session_cleanup() 里。
       原因：只在成功时清理，等于清理依赖攻击者去登录成功一次，
       纯爆破路径下这张表会无限增长。 */
  delete from login_attempts
   where lower(nick) = lower(p_nick) and ok = false;

  update users set last_seen = now() where id = u.id;
  tk := issue_session(u.id, false);
  -- 不返回 real_name：前端无该字段，且避免实名信息随登录响应外泄
  return json_build_object('ok', true, 'token', tk, 'uid', u.id,
    'nick', u.nick, 'role', u.role, 'status', u.status);
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


-- ---------- 校验 ----------
\echo '=== user_login 是否还有失败的 nextval ==='
select case when prosrc like '%perform nextval%state_rev%' and prosrc like '%ok = false%'
  then '仍有多余 nextval' else 'OK: 失败不推进序号' end as s006
from pg_proc where proname='user_login';
\echo '=== 全局闸门 ==='
select case when prosrc like '%>= 100%' then 'OK: 有全局闸门' else '缺全局闸门' end as s008
from pg_proc where proname='user_login';
\echo '=== session_cleanup 是否清 login_attempts ==='
select case when prosrc like '%login_attempts%' then 'OK: 会清' else '缺清理' end as s007
from pg_proc where proname='session_cleanup';
