create or replace function _p() returns int language sql stable security invoker as $$ select 1 $$;
select has_function_privilege('anon','site_ready()','EXECUTE') as site_ready,
       has_function_privilege('anon','state_get()','EXECUTE') as state_get,
       has_function_privilege('anon','gate_check(text)','EXECUTE') as gate_check,
       has_function_privilege('anon','_p()','EXECUTE') as 新函数_应false;
drop function _p();
