/*!
 * account.js —— 个人主页的账号区（Q-Site-S-121）
 *
 * 做什么：在导航条上显示"当前是谁 · 什么角色"，并提供登录 / 退出。
 * 支撑"跨项目统一账号"：Chat 登录后，回到主页这边也能看到身份。
 *
 * ── 为什么能拿到 Chat 的登录状态 ──────────────────────────────
 * 主页（https://liuyiming2024.github.io/）与聊天室
 * （https://liuyiming2024.github.io/Chat/）**同源** ——
 * localStorage 按 origin 共享，所以 Chat 存的会话令牌这边读得到。
 * 不需要任何跨域桥接、不需要 iframe、不需要 postMessage。
 *
 * ── 刻意不做的事：不在主页重造一套登录表单 ──────────────────
 * 登录要走的东西太多，复制一份必然出错：
 *   · 失败计数与冻结（15 分钟 8 次）
 *   · 全局爆破闸门
 *   · "记住账号 30 天"与"保护密码不记"两套凭据的区别
 *   · 桌面版桥接票据自动登录
 * 在主页另起一份，等于把上面每一条都重新实现一遍，
 * 而且两边一定会逐渐不一致（改了这边忘了那边）。
 *
 * 所以这里只做**读取与退出**，登录跳去 Chat 那唯一的入口。
 * 这已经是"统一账号"的实质：一处登录、处处可见、处处可退。
 *
 * ── 失败一律静默 ──────────────────────────────────────────────
 * 主页是门面，后端挂了、没登录、令牌过期，都只显示"登录"按钮，
 * 不弹错误、不往控制台刷红。门面页不该因为后端异常而吓到人。
 */

(function () {
  'use strict';

  /* 与 Chat 的 sb.js 保持一致的键名与内置后端。
     publishable key 按设计就是公开的（sb.js 里有长注释解释为何可以硬编码），
     真正的边界在服务端函数体内的鉴权，不在这把钥匙。 */
  var CFG_KEY = 'wxlg_sb_cfg';
  var TOK_KEY = 'wxlg_sb_token';
  var DEF_URL = 'https://pimryrsxkwyafmponegp.supabase.co';
  var DEF_KEY = 'sb_publishable_jPrK6j5l9NGbnLKcytTegg_di1njO8t';

  var CHAT = 'https://liuyiming2024.github.io/Chat/';

  var ROLE = { owner: '站长', admin: '管理员', member: '成员' };

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { } }

  function cfg() {
    var url = DEF_URL, key = DEF_KEY;
    var raw = ls(CFG_KEY);
    if (raw) {
      try {
        var o = JSON.parse(raw);
        if (o && o.url) url = o.url;
        if (o && o.key) key = o.key;
      } catch (e) { /* 配置坏了就用内置的，不打断 */ }
    }
    return { url: url, key: key };
  }

  /* 直接 fetch，不依赖 Chat 的 sb.js ——
     主页只用到两个 RPC，为它加载一整个访问层不划算，
     也避免主页被 Chat 的内部改动牵连。 */
  function rpc(name, body) {
    var c = cfg();
    var tok = ls(TOK_KEY);
    var h = {
      'apikey': c.key,
      'Authorization': 'Bearer ' + c.key,
      'Content-Type': 'application/json'
    };
    /* ⚠ 会话走 x-session 头，不是 Authorization。
       放进 Bearer 会被网关当成 JWT 解析，报 Invalid JWT。 */
    if (tok) h['x-session'] = tok;
    return fetch(c.url + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: h, body: JSON.stringify(body || {})
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* 头像：昵称首字 + 由昵称算出的色相。
     ★ 必须与 Chat 的 ui.js avatar() 用同一套算法 ——
       否则同一个人在主页和聊天室里是两个颜色的头像，
       看着像两个账号，而实际上这是"统一账号"最直观的破绽。 */
  function avatar(nick, role) {
    var name = nick || '?';
    var ch = String(name).trim().slice(0, 1).toUpperCase();
    var hue = 0;
    for (var i = 0; i < name.length; i++) hue = (hue * 31 + name.charCodeAt(i)) % 360;
    var d = document.createElement('span');
    d.className = 'acct-av';
    d.style.background = 'hsl(' + hue + ',52%,52%)';
    d.textContent = ch;
    if (role === 'owner') d.classList.add('acct-owner');
    if (role === 'admin') d.classList.add('acct-admin');
    return d;
  }

  function render(host, data) {
    host.innerHTML = '';
    if (!data || !data.ok) {
      var a = document.createElement('a');
      a.className = 'acct-btn';
      a.href = CHAT;
      a.textContent = '登录';
      a.title = '前往聊天室登录（全站通用）';
      host.appendChild(a);
      return;
    }
    var box = document.createElement('div');
    box.className = 'acct-box';
    box.appendChild(avatar(data.nick, data.role));

    var txt = document.createElement('span');
    txt.className = 'acct-name';
    txt.textContent = data.nick;

    var tag = document.createElement('span');
    tag.className = 'acct-role';
    tag.textContent = ROLE[data.role] || data.role;

    box.appendChild(txt);
    box.appendChild(tag);

    /* 待审核要显示出来：他登了录、却什么也做不了，
       不说明原因的话只会以为站点坏了（Chat 服务端会拒，但主页看得到身份）。 */
    if (data.status && data.status !== 'active') {
      var st = document.createElement('span');
      st.className = 'acct-role acct-pending';
      st.textContent = data.status === 'pending' ? '待审核' : (data.status === 'banned' ? '已封禁' : data.status);
      box.appendChild(st);
    }

    var out = document.createElement('button');
    out.className = 'acct-btn acct-out';
    out.type = 'button';
    out.textContent = '退出';
    out.onclick = function () {
      out.disabled = true;
      out.textContent = '…';
      /* ⚠ 必须通知服务端清会话（E-079 的教训）：
         只清本地的话，那条令牌在服务端还有效 14 天，
         在公用电脑上点了"退出"却仍能被继续使用。 */
      rpc('logout', {}).catch(function () { }).then(function () {
        lsDel(TOK_KEY);
        try { sessionStorage.removeItem(TOK_KEY); } catch (e) { }
        render(host, null);
      });
    };
    box.appendChild(out);
    host.appendChild(box);
  }

  function boot() {
    var host = document.getElementById('acctHost');
    if (!host) return;
    render(host, null);                       // 先给个"登录"，避免空白

    if (!ls(TOK_KEY)) return;                 // 没令牌就到此为止，不发请求
    rpc('whoami', {}).then(function (r) {
      render(host, r);
    }).catch(function () {
      /* 失败只保持"登录"按钮，不报错。
         ⚠ 但**令牌失效要清掉**：否则下次进来还是先显示"退出"再闪成"登录"，
           界面自己打自己的脸。user gone 这种情况尤其要清。 */
      render(host, null);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
