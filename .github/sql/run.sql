select p.proname,
  (pg_get_functiondef(p.oid) like '%1 day%') as has_1day,
  (pg_get_functiondef(p.oid) like '%limit 200%') as has_limit200
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('issue_session','session_cleanup');
