-- Archive 迁移前的依赖体检（只读）
-- 目的：确认账号体系设施齐备、权限点可登记，再决定能不能跑可写迁移。
select 'cur_user' as item, count(*) as n from pg_proc where proname='cur_user'
union all select 'acl_require', count(*) from pg_proc where proname='acl_require'
union all select 'acl_register', count(*) from pg_proc where proname='acl_register'
union all select 'profiles表已存在', count(*) from information_schema.tables where table_name='profiles'
union all select 'profile_entries已存在', count(*) from information_schema.tables where table_name='profile_entries'
union all select 'profile_notes已存在', count(*) from information_schema.tables where table_name='profile_notes'
union all select 'profile_summaries已存在', count(*) from information_schema.tables where table_name='profile_summaries'
union all select 'profile_media已存在', count(*) from information_schema.tables where table_name='profile_media';
