#!/usr/bin/env bash
# 提交前一次性检查。
#
# 为什么要有它：
#   "改了源码没同步 www/" 这件事已经发生了三次 ——
#   每次都是测试全绿、推送完成，然后结构断言报红。
#   根因不是忘了某一条命令，是"要跑的东西散在好几个地方"。
#   所以合成一条：同步 → 全端校验 → 结构断言 → 单元测试 → SQL e2e。
#
# 用法： bash scripts/precheck.sh
# 退出码非 0 就是没过，别推。
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
TOOL="$(cd "$ROOT/.." && pwd)/Tool"
fail=0
step() { echo; echo "════ $1 ════"; }

step "1/5 同步 www/（安卓 APP 与桌面版的打包目录）"
node scripts/sync-www.js || fail=1

step "2/5 全端打包目录校验"
node scripts/sync-www.js --check || fail=1

step "3/5 结构断言"
node "$TOOL/tests/structure.assert.js" || fail=1

step "4/5 离线队列测试"
node "$TOOL/tests/offline.test.js" || fail=1

step "5/5 SQL 端到端"
timeout 500 python3 "$TOOL/tests/sql.e2e.py" "$ROOT/chat/supabase/schema.sql" || fail=1

echo
if [ "$fail" = "0" ]; then echo "✅ 全部通过，可以提交"; else echo "❌ 有失败项，别推"; fi
exit "$fail"
