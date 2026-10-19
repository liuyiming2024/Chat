select coalesce(gate_disabled,false) as 门禁已关,
       (gate_hash is not null) as 有保护密码,
       site_name as 站点名, allow_register as 允许注册
  from site where id=true;
select count(*) as 用户数 from users;
select (site_ready()) as site_ready返回;
select count(*) as 事件触发器数 from pg_event_trigger where evtname='trg_revoke_public_on_new_function';
