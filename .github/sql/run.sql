-- 考古复核：精确检测（避开注释污染）
-- 只统计"真实调用"（perform nextval），注释里的文字不算。

select 'A_login_nextval_count' as chk,
  (length(prosrc) - length(replace(prosrc,'perform nextval','')))/15 as val
from pg_proc where proname='user_login';

select 'B_login_has_global' as chk,
  case when prosrc like '%ok = false and created_at > now()%' then 'OK' else 'MISSING' end as val
from pg_proc where proname='user_login';

select 'C_msg_delete_exists' as chk, count(*)::text as val
from pg_proc where proname in ('msg_delete','msg_recall');

select 'D_funcs_actual' as chk, string_agg(proname,',' order by proname) as val
from pg_proc where proname like 'msg_%' or proname like 'invite_%';

select 'E_login_attempts_rows' as chk, count(*)::text as val from login_attempts;

select 'F_sessions_rows' as chk, count(*)::text as val from sessions;
