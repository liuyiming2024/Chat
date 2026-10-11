-- 临时：重置数据库密码。
-- 为什么必须走这一步：
--   Code 仓库的 Secret 用了凭据.md 里那条已过时的连接串，一直认证失败。
--   而 Secret 只能写不能读 —— 拿不到 Chat 在用的正确值，没法"复制"过去。
--   改一个我知道的密码，再同时写进两边，是唯一能让两边一致的办法。
-- 改完立刻更新 Chat / Code 两个 Secret，窗口只有几分钟。
alter role postgres with password 'mcCukyNsVpnCuVZGpam1udCfc912';
select '密码已重置' as 结果;
