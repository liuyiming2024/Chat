-- 历史考古：只读诊断（确认"临时上线"过的功能是否真的还在库里）
-- 纯 SQL，不使用 psql 元命令。

select '1_TABLES' as chk, string_agg(table_name, ',') as val
from information_schema.tables
 where table_schema='public'
   and table_name in ('messages','login_attempts','invites','sessions','rooms','users');

select '2_MSG_REV' as chk, count(*)::text as val
from information_schema.columns
 where table_schema='public' and table_name='messages' and column_name='rev';

select '3_STATE_DELTA' as chk,
  case when prosrc like '%m.rev%' and prosrc like '%p_since%' then 'OK: 按 rev 比大小'
       when prosrc like '%created_at%' then '回退: 仍在按时间窗'
       else '未知/函数不存在' end as val
from pg_proc where proname='state_delta';

select '4_LOGIN_GLOBAL_GATE' as chk,
  case when prosrc like '%ok = false and created_at > now()%' then 'OK: 有全局闸门'
       else '缺失: 无全局闸门（换昵称爆破拦不住）' end as val
from pg_proc where proname='user_login';

select '5_LOGIN_NEXTVAL' as chk,
  case when prosrc like '%state_rev%' then '回退: 残留 nextval(S-006)'
       else 'OK: 无 nextval' end as val
from pg_proc where proname='user_login';

select '6_CLEANUP_LOGIN' as chk,
  case when prosrc like '%login_attempts%' then 'OK: 会清理'
       else '缺失: 不清理（表无限增长）' end as val
from pg_proc where proname='session_cleanup';

select '7_FUNCS' as chk, string_agg(proname, ',' order by proname) as val
from pg_proc
 where proname in ('state_delta','state_peek','user_login','session_cleanup',
                   'invite_create','invite_redeem','invite_revoke',
                   'msg_send','msg_edit','msg_recall','msg_media');
