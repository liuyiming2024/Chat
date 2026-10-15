-- 站点实际数据：判断"消息能存能取"是否真的跑通过
select '用户数' as item, count(*)::text as n from users
union all select '房间数', count(*)::text from rooms
union all select '消息数', count(*)::text from messages
union all select '媒体数', count(*)::text from media
union all select '已通过用户', count(*)::text from users where status='active';

-- 站点是否已初始化
select key, left(value,40) as v from site_meta limit 8;
