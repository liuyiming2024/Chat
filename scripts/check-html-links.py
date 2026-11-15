#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查所有 HTML 里的相对链接目标是否真实存在。

为什么需要：聊天页侧栏三个政策链接曾写成 `docs/...`，
而页面在 `chat/` 子目录、文档在站点根 `docs/` —— 点了全是 404。
这类错误静态看不出来（字符串长得完全正常），只有按「HTML 所在目录」
解析一遍才能发现。

刻意不检查的（检查了必然假红）：
  · http(s)://、//、mailto:、tel:、data:、javascript:  → 外链 / 协议
  · 以 / 开头  → 站点根绝对路径，可能指向兄弟仓库（如统一身份服务）
  · #锚点、?查询  → 同页跳转，剥掉后若为空则跳过
  · 含 ${{ 的模板串
相对链接按文件所在目录解析；目标可以是文件或目录。

用法：python3 scripts/check-html-links.py     # 有 404 退出码 1
"""
import pathlib, re, sys, urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP = ('http://', 'https://', '//', 'mailto:', 'tel:', 'data:',
        'javascript:', '#', '?')

REF = re.compile(r'''(?:src|href)\s*=\s*["']([^"']+)["']''', re.I)


def targets(html_text, html_path):
    for raw in REF.findall(html_text):
        u = raw.strip()
        if not u or u.startswith(SKIP) or '${{' in u:
            continue
        u = urllib.parse.unquote(u.split('#')[0].split('?')[0])
        if not u or u.startswith(SKIP):
            continue
        if u.startswith('/'):
            continue
        yield raw, (html_path.parent / u).resolve()


bad, total = [], 0
for html in sorted(ROOT.rglob('*.html')):
    if '.github' in html.parts:
        continue
    try:
        text = html.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        continue
    for raw, dest in targets(text, html):
        total += 1
        # 解析结果必须仍在仓库内（防止 ../ 越界后碰巧命中沙箱别的文件）
        try:
            dest.relative_to(ROOT.resolve())
        except ValueError:
            bad.append((html.relative_to(ROOT), raw, '解析到仓库外'))
            continue
        if not dest.exists():
            bad.append((html.relative_to(ROOT), raw, str(dest.relative_to(ROOT))))

if bad:
    print('HTML 相对链接检查：%d 处引用，%d 个目标不存在' % (total, len(bad)),
          file=sys.stderr)
    for f, raw, why in bad:
        print('  ✗ %s  ->  %s  (%s)' % (f, raw, why), file=sys.stderr)
    print('\n修法：按「该 HTML 所在目录」推算相对路径；跨仓链接请用绝对路径。',
          file=sys.stderr)
    sys.exit(1)
print('✅ %d 处 HTML 相对链接目标全部存在' % total)
