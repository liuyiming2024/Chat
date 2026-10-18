/* S-141 验证：门禁限流 */
delete from login_attempts where kind='gate';
select count(*) as gate失败数_清空后 from login_attempts where kind='gate';

/* 有门模式？先看站点当前状态 */
select (gate_hash is not null) as has_gate, coalesce(gate_disabled,false) as gate_off from site where id=true;

/* 手工灌 25 条门禁失败记录，模拟爆破 */
insert into login_attempts (nick, kind, ok)
select '__gate__', 'gate', false from generate_series(1,25);
select count(*) as 已灌入 from login_attempts where kind='gate' and ok=false
  and created_at > now() - interval '15 minutes';

/* 关键：确认 gate_check 现在会在计数超阈值时返回 ok:false 而不是放行 */
select proname, pg_get_function_result(oid) as 返回类型
from pg_proc where proname='gate_check';
select count(*) as kind列存在 from information_schema.columns
 where table_name='login_attempts' and column_name='kind';
