\echo '===== 站点状态 ====='
select site_ready() as 站点已初始化, gate_passed() as 已过门禁;

\echo '===== 统一身份函数 ====='
select string_agg(proname, ', ' order by proname) as auth函数
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and proname like 'auth_%';

\echo '===== 表清单 ====='
select string_agg(table_name, ', ' order by table_name) as 表
from information_schema.tables where table_schema='public';

\echo '===== 关键函数是否都在 ====='
select string_agg(proname, ', ' order by proname) as 函数
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and proname in ('site_init','gate_check','user_register','user_login',
                  'msg_send','forum_list','forum_post','forum_del',
                  'session_cleanup','logout','state_seq');

\echo '===== sessions 表结构（确认无明文 token）====='
select string_agg(column_name, ', ' order by ordinal_position) as sessions列
from information_schema.columns where table_name='sessions';

\echo '===== 初始数据 ====='
select (select count(*) from users) as 用户数,
       (select count(*) from sessions) as 会话数,
       (select count(*) from messages) as 消息数,
       (select count(*) from forum_posts) as 帖子数;
