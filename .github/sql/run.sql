select table_name from information_schema.tables
 where table_schema='public' and table_name similar to '(users|rooms|messages|media|site)%|%media%'
 order by table_name;
