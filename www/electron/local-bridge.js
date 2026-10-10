/* ------------------------------------------------------------------
 * electron/local-bridge.js —— 本机 HTTP 桥接服务
 *
 * 做什么：桌面版已经登录之后，在本机开一个只监听 127.0.0.1 的小服务。
 *         网页版（github.io）来问一句"你现在登录的是谁"，拿到票据后
 *         去服务端换成会话 —— 于是网页端不用再输一遍账号密码。
 *
 * 这就是腾讯 QQ 空间那套"本机客户端开端口、网页来探测"的机制。
 * 换成自建场景后，卡住人的两道墙自动消失：
 *   · "本地服务只认自家域名" —— 自己写的，白名单里放谁由我们决定
 *   · "凭证要腾讯密钥才认"   —— 票据由服务端签发，我们自己的
 *
 * 真正要处理的只剩两个响应头：
 *   Access-Control-Allow-Origin            （CORS）
 *   Access-Control-Allow-Private-Network   （PNA 预检：公网页面访问 localhost 必过这道）
 *
 * ⚠ 安全上唯一不能省的一步：Origin 白名单。
 *   端口一开，任何网页都能来探。白名单不是可选项，它正是"自己认自己"那一步。
 *   用 "*" 等于给本机开一个可被任意网站探测的口子。
 * ------------------------------------------------------------------ */
'use strict';
const http = require('http');

/* 固定端口。换端口要同步改 chat/js/bridge.js。 */
const PORT = 37821;
const HOST = '127.0.0.1';

/* 只认这些来源。没有通配，没有例外。 */
const ALLOW_ORIGIN = new Set([
  'https://liuyiming2024.github.io'
  // 本地开发时可以临时加 'http://localhost:8080'，请勿提交通配
]);

/* 票据只在内存里，不落盘、不写日志。 */
let state = { nick: '', code: '', at: 0 };

function corsHeaders(origin, okOrigin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  if (okOrigin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function createServer() {
  const srv = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const okOrigin = ALLOW_ORIGIN.has(origin);

    /* 预检：PNA 要求对 OPTIONS 明确回 Allow-Private-Network */
    if (req.method === 'OPTIONS') {
      const h = corsHeaders(origin, okOrigin);
      const wantsPNA = req.headers['access-control-request-private-network'] === 'true';
      if (wantsPNA && okOrigin) h['Access-Control-Allow-Private-Network'] = 'true';
      res.writeHead(okOrigin ? 204 : 403, h);
      res.end();
      return;
    }

    if (!okOrigin) {
      const h = corsHeaders(origin, false);
      res.writeHead(403, h);
      res.end(JSON.stringify({ err: 'origin not allowed' }));
      return;
    }

    const h = corsHeaders(origin, true);
    h['Access-Control-Allow-Private-Network'] = 'true';

    if (req.url === '/identity') {
      /* 只回昵称，不回任何凭据材料之外的东西。
         票据本身是单次使用 + 5 分钟过期，且只能换到"这个 uid"，
         所以即使被白名单外的路径看到也换不出别的身份。 */
      res.writeHead(200, h);
      res.end(JSON.stringify({
        nick: state.nick,
        code: state.code,
        at: state.at
      }));
      return;
    }

    res.writeHead(404, h);
    res.end(JSON.stringify({ err: 'not found' }));
  });

  /* 端口被占用时静默失败：不能因为桥接起不来就让应用打不开 */
  srv.on('error', () => { });

  srv.listen(PORT, HOST);
  return srv;
}

module.exports = {
  PORT,
  createServer,
  publish(nick, code) { state = { nick: nick || '', code: code || '', at: Date.now() }; },
  clear() { state = { nick: '', code: '', at: 0 }; },
  current() { return state; }
};
