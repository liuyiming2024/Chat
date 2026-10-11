#!/usr/bin/env node
/* sync-www.js —— 把源码同步到 APP / 桌面版的打包目录
 * ------------------------------------------------------------------
 * www/ 是 Capacitor（安卓）与 electron-builder（Windows/macOS/Linux）
 * 的共同打包目录：
 *   - capacitor.config.json 的 webDir 指向 www
 *   - package.json 的 build.files 里是 www/**
 *
 * 源码在仓库根目录的 chat/ docs/ tieba/ api/ assets/。
 * 两边没有任何自动同步机制，改了源码会打进旧版本 —— 已经真实发生过：
 *
 *   2026-10-11 修了 chat/js/app.js 的跨房间状态泄漏，
 *   www/chat/js/app.js 还是旧的 → 安卓用户装到的 APP 里 bug 一个没修，
 *   而我们当时以为修好了。
 *
 * 用法：
 *   node scripts/sync-www.js            # 同步
 *   node scripts/sync-www.js --check    # 只检查，不同步（CI 用）
 *
 * --check 下不一致就退出码 1，不改任何文件。
 * ------------------------------------------------------------------ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* 这些目录源码在根，www/ 下必须有完全一致的一份。
   用户点名"使用手册同步"：docs 漏了的话，
   APP 里的手册跟网页版说的不是一回事 —— 比代码不同步更误导人。 */
const DIRS = ['chat', 'docs', 'tieba', 'api', 'assets'];
const FILES = ['LICENSE', 'README.md'];

/* www/index.html 是【特制】的重定向页（一行 meta refresh），
   让 APP 打开直接进聊天室。它不是根 index.html 的副本，
   绝不能被覆盖 —— 所以不在同步列表里，且 --check 时会专门验证。 */
const ENTRY = 'www/index.html';
const ENTRY_MARK = 'url=./chat/index.html';

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); }
    catch (e) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(path.relative(ROOT, p));
    }
  }
  return out.sort();
}

function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}

function same(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); }
  catch (e) { return false; }
}

function main() {
  const checkOnly = process.argv.includes('--check');
  let bad = 0;

  // 先验证特制入口还在 —— 它最容易在批量拷贝时被误覆盖
  const entryPath = path.join(ROOT, ENTRY);
  if (fs.existsSync(entryPath)) {
    const t = fs.readFileSync(entryPath, 'utf8');
    if (t.indexOf(ENTRY_MARK) < 0) {
      console.error('✗ www/index.html 不是重定向页了');
      console.error('  它应该是 APP 专用入口（一行 meta refresh 进 chat/index.html），');
      console.error('  不是根落地页的副本。被覆盖的话 APP 打开会变成项目首页。');
      bad++;
    } else if (checkOnly) {
      console.log('✓ www/index.html 仍是 APP 专用重定向入口');
    }
  }

  for (const d of DIRS) {
    const src = path.join(ROOT, d);
    const dst = path.join(ROOT, 'www', d);
    if (!fs.existsSync(src)) continue;

    if (!checkOnly) copyDir(src, dst);

    if (!fs.existsSync(dst)) {
      console.error('✗ www/%s 不存在 —— 该目录根本没进打包目录', d);
      bad++;
      continue;
    }

    const sa = walk(src), sb = walk(dst);
    const relA = sa.map(f => path.relative(src, f));
    const relB = sb.map(f => path.relative(dst, f));
    const setB = new Set(relB);
    const missing = relA.filter(f => !setB.has(f));
    const extra = relB.filter(f => !new Set(relA).has(f));

    let diff = 0;
    for (const f of relA) {
      if (!setB.has(f)) continue;
      if (!same(path.join(src, f), path.join(dst, f))) diff++;
    }

    if (missing.length || extra.length || diff) {
      console.error('✗ %s 与 www/%s 不一致：缺 %d，多 %d，内容不同 %d',
        d, d, missing.length, extra.length, diff);
      missing.slice(0, 5).forEach(f => console.error('    缺 ' + f));
      extra.slice(0, 5).forEach(f => console.error('    多 ' + f));
      bad++;
    } else {
      console.log('✓ %s 与 www/%s 一致（%d 个文件）', d, d, relA.length);
    }
  }

  for (const f of FILES) {
    const src = path.join(ROOT, f);
    const dst = path.join(ROOT, 'www', f);
    if (!fs.existsSync(src)) continue;
    if (!checkOnly) fs.copyFileSync(src, dst);
    if (!same(src, dst)) { console.error('✗ %s 与 www/%s 不一致', f, f); bad++; }
    else console.log('✓ %s 一致', f);
  }

  if (bad) {
    console.error('');
    console.error('%d 处不一致。' + (checkOnly
      ? '跑 node scripts/sync-www.js 同步后再提交。'
      : '同步后仍不一致，请检查。'), bad);
    process.exit(1);
  }
  console.log('');
  console.log(checkOnly ? '✅ 全端打包目录一致' : '✅ 全端源码已同步到 www/');
}

main();
