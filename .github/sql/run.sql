-- 列出可能被 create or replace 拒绝的函数：同名但参数或返回类型不同
select p.proname as 函数名,
       pg_get_function_identity_arguments(p.oid) as 参数,
       pg_get_function_result(p.oid) as 返回类型
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('gate_check','gate_set','user_login','user_register',
                    'bridge_ticket_create','bridge_ticket_redeem',
                    'state_get','state_peek','msg_send','device_trust')
order by p.proname, 参数;
