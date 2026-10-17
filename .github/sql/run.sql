/* 核实：git 历史里泄露的三个密码，现在是否仍然有效 */
begin;
do $$
declare r json; ok boolean;
begin
  -- ① 门禁密码 ***REMOVED***（3f70c6c7，2026-10-08）
  begin
    select gate_check('***REMOVED***') into r;
    raise notice '① ★门禁密码 ***REMOVED*** 仍然有效 = %', (r->>'ok');
  exception when others then
    raise notice '① 门禁密码已失效或站点未初始化：%', SQLERRM;
  end;

  -- ② 站长密码 ***REMOVED***
  begin
    select auth_login('站长','***REMOVED***') into r;
    raise notice '② ★站长密码仍然有效 = %', (r->>'ok');
  exception when others then
    raise notice '② 站长密码调用失败：%', SQLERRM;
  end;
end $$;
rollback;
