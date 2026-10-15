select pg_get_functiondef(p.oid) from pg_proc p
 where p.proname in ('cur_token_hash','state_delta');
