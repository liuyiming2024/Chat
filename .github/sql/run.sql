-- 验证 S-085 的服务端改动是否真的生效（不能只信"迁移没报错"）
select 'users.rev列' as item, count(*)::text as n from information_schema.columns
 where table_schema='public' and table_name='users' and column_name='rev'
union all select 'rooms.rev列', count(*)::text from information_schema.columns
 where table_schema='public' and table_name='rooms' and column_name='rev'
union all select 'users触发器', count(*)::text from pg_trigger
 where not tgisinternal and tgname like 'users_rev%'
union all select 'rooms触发器', count(*)::text from pg_trigger
 where not tgisinternal and tgname like 'rooms_rev%';

-- 现有行的 rev 是不是 null（触发器只对新建/更新生效，老数据没号）
select 'users有rev的行' as item, count(*)::text as n from users where rev is not null
union all select 'users总行', count(*)::text from users
union all select 'rooms有rev的行', count(*)::text from rooms where rev is not null
union all select 'rooms总行', count(*)::text from rooms;

select tgname, tgrelid::regclass::text as tbl from pg_trigger
 where not tgisinternal and (tgname like 'users_rev%' or tgname like 'rooms_rev%')
 order by tgname;
