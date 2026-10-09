-- 修复：站长被自己误封（user_review 此前没有自保护）
-- 不写任何密码，只改状态。

\echo '===== 修复前 ====='
select nick, role, status from users order by created_at;

-- 站长恢复为正常，并清掉禁言
update users set status='active', muted_until=null where role='owner';

-- 清理可能存在的脏会话（封禁期间产生的）
delete from sessions where user_id in (select id from users where role='owner');

\echo '===== 修复后 ====='
select nick, role, status from users order by created_at;

\echo '===== 确认自救通道可用 ====='
select proname as 自救函数 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and proname='user_self_unban';

\echo '===== 确认自保护已装上 ====='
select p.proname as 函数,
       case when pg_get_functiondef(p.oid) like '%self_guard%' then '已保护' else '★无保护' end as 状态
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in ('user_review','user_mute','user_role_set','user_perms_set','user_delete')
order by 2,1;
