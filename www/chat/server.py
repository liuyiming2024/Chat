#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
聊天室 —— 自带运行环境（纯静态服务器，Python 3 标准库，零依赖）

【定位】本文件只是一个**静态文件服务器**，用来规避 file:// 直开时浏览器对
        IndexedDB / WebAssembly / fetch 的限制。它不提供任何业务接口，
        不保存聊天数据，不参与同步。

【为什么不做后端同步】项目要求"本地版与上线版（GitHub Pages 静态托管）
        不得存在整体性、思路性、架构性的不同"。若引入后端状态同步，
        本地就跑一套、线上就跑另一套，等于两套架构。因此整个项目的
        唯一架构是：浏览器内状态 + localStorage 快照 + IndexedDB 媒体
        + BroadcastChannel 多标签同步（见 js/sync.js）。
        本服务器只是把同一份前端文件以 http:// 方式送出去——
        用它打开与部署到 GitHub Pages，运行的是完全相同的前端代码。

启动：
    python3 server.py                # 监听 0.0.0.0:8000
    python3 server.py --port 8080
    python3 server.py --dir ./dist   # 指定站点根目录

然后浏览器打开 http://localhost:8000/ 即可。
协议：MIT。
"""

import argparse
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

MIME_EXTRA = {
    '.wasm': 'application/wasm',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
}


class Handler(SimpleHTTPRequestHandler):
    """静态文件处理器：禁用缓存便于开发调试，其余行为同标准库。"""
    server_version = 'WXLG-Static/1.0'

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        for ext, ctype in MIME_EXTRA.items():
            self.extensions_map.setdefault(ext, ctype)

    def end_headers(self):
        # 开发期禁用缓存；部署到 Pages 时由 CDN 自行决定
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('[%s] %s\n' % (self.log_date_time_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser(description='聊天室 静态运行环境')
    ap.add_argument('--host', default='0.0.0.0', help='监听地址，默认 0.0.0.0')
    ap.add_argument('--port', type=int, default=8000, help='端口，默认 8000')
    ap.add_argument('--dir', default=HERE, help='站点根目录，默认本文件所在目录')
    args = ap.parse_args()

    root = os.path.abspath(args.dir)
    if not os.path.isdir(root):
        print('目录不存在：%s' % root)
        return 1
    os.chdir(root)

    handler = partial(Handler, directory=root)
    srv = ThreadingHTTPServer((args.host, args.port), handler)
    srv.daemon_threads = True

    print('=' * 60)
    print(' 聊天室 · 静态运行环境已启动')
    print(' 访问地址 : http://localhost:%d/' % args.port)
    print(' 站点目录 : %s' % root)
    print(' 说明     : 仅静态托管，不存数据、不做同步；')
    print('            与 GitHub Pages 上线版运行完全相同的前端代码。')
    print('=' * 60)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。')
        srv.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
