-- 清理刚才的验证消息，恢复干净状态
delete from messages where body = '来自服务端的测试消息';
