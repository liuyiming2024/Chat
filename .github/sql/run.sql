-- messages 表为什么是 2：看分别在哪个 schema
select table_schema, table_name from information_schema.tables
 where table_name='messages';

-- 真实存在的 msg_* / state_* 函数
select p.proname, pg_get_function_arguments(p.oid) as args
  from pg_proc p
 where p.proname like 'msg%' or p.proname like 'state%'
 order by p.proname;
