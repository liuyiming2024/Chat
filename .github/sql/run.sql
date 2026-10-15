select '用户数' as item, count(*)::text as n from users
union all select '其中已通过', count(*)::text from users where status='active'
union all select '房间数', count(*)::text from rooms
union all select '消息数', count(*)::text from messages
union all select '媒体数', count(*)::text from media_objects;

select * from site limit 3;
