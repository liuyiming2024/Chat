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

/* 打包目录里不该出现的后端/开发文件（相对对应源码目录）。
   理由：www/ 会被 package.json 的 build.files（www/**）整体打进
   桌面/安卓安装包，而这些文件是【服务端图纸】，运行时前端并不加载：
     · supabase/*.sql  —— 建库脚本，含全部表结构与权限逻辑（约 200KB）。
                         泄露不构成安全事故，但等于把服务端权限设计图纸
                         发给每个用户，纯属打包卫生问题（S-013 已指摘）。
     · server.py       —— 本地开发用的静态服务，APP 里不跑。
     · native/accel.cpp —— 原生加速源码，桌面版通过 native 通道另行打包，
                          不该以源码形式塞进 www。
   所以同步与校验时都要跳过它们。 */
const SKIP_SUFFIX = [
  'supabase/',   // 命中目录则整棵子树跳过（路径段形式，匹配任意层级）
  'server.py',
  'native/'
];
function shouldSkip(relPath) {
  const p = relPath.split(path.sep).join('/');
  return SKIP_SUFFIX.some(s => p.indexOf(s) >= 0);
}

/* www/ 下不该存在 electron/ —— package.json 的 build.files 同时列了
   www/** 和 electron/**，所以 electron 会被打进去两次，
   而 www/electron 这份是冗余的：
     · main.js 里 __dirname/../www 在它下面会解析成 www/www（不存在）
     · 它不在同步列表里，改了源码也不会跟着变，迟早是旧版
   审查官提过两次（S-013 / S-046）都说它在，因为之前只是"以为删了"。
   这里检查它确实不在了。 */
const FORBIDDEN = ['www/electron'];

/* KEEP-WWW：www/ 是网页版与旧客户端的打包目录，必须持续可用。
   www/index.html 是【特制】的重定向页（一行 meta refresh），
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

/* ⚠ 原来是「先 rmSync 整个目录，再 cpSync 整个目录」。
   实测在某些文件系统（overlay/gVisor）上 rmSync 会抛
   ENOTEMPTY: directory not empty —— 目录没删干净，
   而调用处没有 try/catch，错误直接抛出，
   于是 dst 处于"删了一半又复制了一半"的状态。
   更糟的是脚本仍然继续往下比对，输出 ✓ 或 ✗ 随删没删干净而随机 ——
   **同一个脚本、同一份代码，结论不稳定**，这比稳定报错更难查。

   所以改成：不整目录删除，逐文件比对后只覆盖内容不同的那些。
   好处：① 不会遇到 ENOTEMPTY；② 快得多（不必每次全量重写）；
        ③ 只动真正变的文件，副作用小。 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const rel = walk(src).map(f => path.relative(src, f)).filter(f => !shouldSkip(f));
  let copied = 0;
  for (const f of rel) {
    const a = path.join(src, f), b = path.join(dst, f);
    try {
      if (same(a, b)) continue;
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.copyFileSync(a, b);
      copied++;
    } catch (e) {
      console.error('✗ 同步失败 %s：%s', f, e.message);
      throw e;      /* 失败必须暴露，不能带着半同步状态继续 */
    }
  }
  return copied;
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

    if (!checkOnly) {
      copyDir(src, dst);
      /* copyDir 只覆盖、不删除：被 shouldSkip 排除的文件，若以前
         同步进过 www/（如 supabase/、server.py），不会自动消失。
         这里在同步模式下把它们从 dst 里清掉，保证打包目录真不含这些文件。 */
      const dropRel = walk(dst).map(f => path.relative(dst, f)).filter(f => shouldSkip(f));
      for (const f of dropRel) {
        try { fs.unlinkSync(path.join(dst, f)); } catch (e) { }
        /* 顺带清掉可能因此变空的父目录（不深挖，尽力即可） */
        const parent = path.dirname(path.join(dst, f));
        try { if (walk(parent).length === 0) fs.rmdirSync(parent); } catch (e) { }
      }
    }

    if (!fs.existsSync(dst)) {
      console.error('✗ www/%s 不存在 —— 该目录根本没进打包目录', d);
      bad++;
      continue;
    }

    const sa = walk(src), sb = walk(dst);
    const relA = sa.map(f => path.relative(src, f)).filter(f => !shouldSkip(f));
    const relB = sb.map(f => path.relative(dst, f)).filter(f => !shouldSkip(f));
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

  for (const d of FORBIDDEN) {
    if (fs.existsSync(path.join(ROOT, d))) {
      console.error('✗ %s 不该存在 —— 它是 electron/ 的冗余副本，'
        + '被 www/** 一起打包且路径会算错', d);
      bad++;
    } else {
      console.log('✓ %s 不存在（正确）', d);
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
