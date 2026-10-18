/* S-141 实测门禁限流。
   ⚠ 用显式事务包住 + rollback：
     开门会改变线上门禁状态，哪怕只有几秒也不能冒这个险。
     整个文件跑完线上状态与跑之前完全一致。 */
begin;
update site set gate_disabled=false,
       gate_hash=crypt('TestPwOnly', gen_salt('bf',8)) where id=true;

/* ① 已有 25 条 gate 失败记录（>= 阈值 20）→ 应被限流挡住 */
select gate_check('wrong-1') as 超限时应返回_ok_false;

/* ② 清空计数后再试 → 应返回"保护密码错误"（并记一条失败） */
delete from login_attempts where kind='gate';
select gate_check('wrong-2') as 清空后应返回_密码错误;
select count(*) as 上一步记了几条失败 from login_attempts where kind='gate' and ok=false
  and created_at > now() - interval '5 minutes';

/* ③ 正确密码 → 应放行且清掉失败计数 */
select (gate_check('TestPwOnly') ->> 'ok') as 正确密码应_ok_true;
select count(*) as 成功后失败计数应归零 from login_attempts where kind='gate' and ok=false;
rollback;

/* 回滚确认：站点仍是关门的 */
select (gate_hash is not null) as has_gate, coalesce(gate_disabled,false) as gate_off from site where id=true;
/* 清掉测试期灌入的记录 */
delete from login_attempts where kind='gate';
select count(*) as 清理后剩余 from login_attempts where kind='gate';
