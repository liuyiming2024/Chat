/* 核实：git 历史里泄露的密码，现在是否仍然有效 */
begin;
do $$
declare r json;
begin
  begin
    select gate_check('omuAS6QbcP') into r;
    raise notice '① ★门禁密码 omuAS6QbcP 仍然有效 = %', (r->>'ok');
  exception when others then
    raise notice '① 门禁密码：%', SQLERRM;
  end;

  begin
    select user_login('站长','bH5TPdrAFsu74M') into r;
    raise notice '② ★站长密码 bH5TPdrAFsu74M 仍然有效 = %', (r->>'ok');
  exception when others then
    raise notice '② 站长密码：%', SQLERRM;
  end;
end $$;
rollback;
