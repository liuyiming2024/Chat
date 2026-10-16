select column_name, data_type from information_schema.columns
 where table_name='users' and column_name similar to '%(at|seen|time)%'
 order by column_name;
