select p.proname, pg_get_function_result(p.oid) as ret
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('issue_session','session_cleanup','gate_check');
