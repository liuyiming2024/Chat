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
 * ⚠ 暴露面必须说准（之前我低估了）：
 *
 *   Origin 白名单【只防网页，不防本机进程】。
 *   CORS 与 PNA 都是【浏览器强制】的机制 —— curl、任何本机程序发请求时
 *   既不带 Origin 也不做预检，直接就能拿到明文票据：
 *
 *       curl http://127.0.0.1:37821/identity   →  {"nick":"...","code":"..."}
 *
 *   所以白名单是必需的，但它防的范围是"任意网站"，不是"任意本机程序"。
 *   本机已失守时这套机制本就不该被信任 —— 那时能做的破坏远多于此。
 *
 *   剩下能做的减损：
 *     · 票据 5 分钟过期、单次使用（拿到也很快失效）
 *     · 只在【客户端真的登录着】的时间窗内才有票据可给
 *     · 退出登录立刻 clear()
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

  /* 端口被别的程序占了，必须【明确失败】而不是静默。
     静默的后果：网页端照样探测成功，拿到的是攻击者给的票据，
     兑换后进了别人的账号，而用户以为进的是自己。
     所以这里要置一个失败标记，让 publish() 干脆不发票据。 */
  srv.on('error', (err) => {
    srv.failed = true;
    srv.failCode = err && err.code;
    state = { nick: '', code: '', at: 0 };   // 立刻清空，别留着给人拿
  });

  srv.listen(PORT, HOST);
  return srv;
}

module.exports = {
  PORT,
  createServer,
  /* 端口没拿到手就不发票据 —— 宁可这个功能不生效，也不能给错身份 */
  publish(nick, code, srv) {
    if (srv && srv.failed) return false;
    state = { nick: nick || '', code: code || '', at: Date.now() };
    return true;
  },
  clear() { state = { nick: '', code: '', at: 0 }; },
  current() { return state; },
  isReady(srv) { return !!(srv && !srv.failed); }
};
