#!/usr/bin/env bash
# ------------------------------------------------------------------
# 一键部署到 GitHub Pages
# 用法：双击本文件，或在终端里执行  bash deploy-pages.sh
#
# 会问你 3 个问题，然后自动 git init / commit / push。
# 推完后需要你手动开一次 Pages（只需一次，脚本会告诉你点哪里）。
# ------------------------------------------------------------------
set -e

echo "=============================================="
echo "  洛谷·微信聊天室 —— 一键部署到 GitHub Pages"
echo "=============================================="
echo

cd "$(dirname "$0")"

# ---- 1. 收集信息 ----
read -r -p "① 你的 GitHub 用户名: " GH_USER
if [ -z "$GH_USER" ]; then echo "用户名不能为空"; exit 1; fi

read -r -p "② 仓库名（直接回车用 luogu-chat）: " GH_REPO
GH_REPO=${GH_REPO:-luogu-chat}

echo
echo "③ 推送方式："
echo "   1) HTTPS（推荐，浏览器弹窗登录）"
echo "   2) SSH（已配好密钥选这个）"
read -r -p "   选 1 或 2 [1]: " MODE
MODE=${MODE:-1}

if [ "$MODE" = "2" ]; then
  REMOTE="git@github.com:${GH_USER}/${GH_REPO}.git"
else
  REMOTE="https://github.com/${GH_USER}/${GH_REPO}.git"
fi

echo
echo "即将推送到: $REMOTE"
read -r -p "确认？[Y/n]: " CONFIRM
if [ "$CONFIRM" = "n" ] || [ "$CONFIRM" = "N" ]; then echo "已取消"; exit 0; fi

# ---- 2. 初始化并推送 ----
echo
echo ">>> 初始化仓库..."
if [ ! -d .git ]; then git init -q; fi
git branch -M main 2>/dev/null || true

git add -A
if git diff --cached --quiet; then
  echo "（没有新的改动）"
else
  git -c user.name="${GH_USER}" -c user.email="${GH_USER}@users.noreply.github.com" \
    commit -q -m "部署聊天室 $(date '+%Y-%m-%d %H:%M')"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

echo ">>> 推送中..."
git push -u origin main

# ---- 3. 尝试用 gh 自动开启 Pages ----
echo
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo ">>> 检测到 gh 已登录，尝试自动开启 Pages..."
  gh api -X POST "repos/${GH_USER}/${GH_REPO}/pages" \
    -f source[branch]=main -f source[path]=/ >/dev/null 2>&1 \
    && echo "    Pages 已开启" \
    || echo "    自动开启失败，请按下面步骤手动点一次"
  echo ">>> 触发一次构建..."
  gh api -X POST "repos/${GH_USER}/${GH_REPO}/pages/builds" >/dev/null 2>&1 || true
else
  echo ">>> 还需你手动做一次（以后不用再弄）："
  echo "    1. 打开 https://github.com/${GH_USER}/${GH_REPO}/settings/pages"
  echo "    2. Source 选  Deploy from a branch"
  echo "    3. Branch 选 main，目录选 /(root)  → Save"
fi

echo
echo "=============================================="
echo "  完成！等 1~2 分钟后访问："
echo "  https://${GH_USER}.github.io/${GH_REPO}/"
echo "=============================================="
echo
echo "首次打开会让你设置「站点保护密码」和站长账号，照着填就行。"
