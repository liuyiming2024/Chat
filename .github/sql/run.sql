/* S-142 实测：计数满时，正确密码能否进去？（事务内，跑完回滚） */
begin;
update site set gate_disabled=false,
       gate_hash=crypt('CorrectHorse9', gen_salt('bf',8)) where id=true;

/* 灌 25 条门禁失败（> 阈值 20） */
insert into login_attempts (nick, kind, ok)
select '__gate__','gate',false from generate_series(1,25);
select count(*) as 已灌失败数 from login_attempts where kind='gate' and ok=false
  and created_at > now() - interval '15 minutes';

/* ① 错密码 → 应被限流挡 */
select gate_check('totally-wrong') as 错密码应被限流;

/* ②★★ 正确密码 → 必须放行（这是 R4-01 的核心） */
select (gate_check('CorrectHorse9') ->> 'ok') as 正确密码应_ok_true;
select count(*) as 成功后失败计数 from login_attempts where kind='gate' and ok=false;

rollback;
select coalesce(gate_disabled,false) as 回滚后仍是关门状态 from site where id=true;
delete from login_attempts where kind='gate';
select count(*) as 清理后剩余 from login_attempts where kind='gate';

/* R4-04：短密码应被拒 */
do $$
begin
  begin
    perform gate_enable('1234');
    raise notice '❌ 4 位密码被接受了';
  exception when others then raise notice '✅ 4 位被拒：%', SQLERRM;
  end;
end $$;
