-- Chat 消息持久化链路体检（只读）
-- 目的：确认"消息能存能取"这条核心链路在服务端是否真的齐备。
select 'messages表' as item, count(*)::text as n
  from information_schema.tables where table_name='messages'
union all select 'messages.rev列', count(*)::text
  from information_schema.columns where table_name='messages' and column_name='rev'
union all select 'messages.edited_at列', count(*)::text
  from information_schema.columns where table_name='messages' and column_name='edited_at'
union all select 'msg_send函数', count(*)::text from pg_proc where proname='msg_send'
union all select 'msg_list函数', count(*)::text from pg_proc where proname='msg_list'
union all select 'msg_edit函数', count(*)::text from pg_proc where proname='msg_edit'
union all select 'msg_delete函数', count(*)::text from pg_proc where proname='msg_delete'
union all select 'state_peek函数', count(*)::text from pg_proc where proname='state_peek'
union all select 'state_pull函数', count(*)::text from pg_proc where proname='state_pull';

-- 实际有多少条消息（有没有真存进去过）
select count(*)::text as 消息总数 from messages;
