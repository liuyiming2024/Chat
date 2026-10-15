select pg_get_functiondef(p.oid) from pg_proc p where p.proname='cur_user';
