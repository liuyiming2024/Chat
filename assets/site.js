/* ------------------------------------------------------------------
 * site.js —— 整站共用脚本
 *   1. 导航高亮（按当前路径自动判断）
 *   2. 深色模式（全站共用同一个偏好，跟随系统可选）
 *   3. 贴吧的 Supabase 配置读写（与聊天室 js/sb.js 用同一套键名规则）
 * 不依赖任何第三方库。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var THEME_KEY = 'wxlg_theme';

  /* ---------- 主题 ---------- */
  function applyTheme(t) {
    var b = document.body;
    var dark;
    if (!t || t === 'auto') {
      dark = !!(g.matchMedia && g.matchMedia('(prefers-color-scheme: dark)').matches);
    } else {
      dark = (t === 'dark');
    }
    b.classList.toggle('dark', dark);
    var btn = document.getElementById('btnTheme');
    /* 换成 SVG 后不能再改 textContent —— 那会把整个 svg 抹掉 */
    if (btn) btn.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-' +
      (dark ? 'sun' : 'moon') + '"/></svg>';
  }
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; }
  }
  function setTheme(t) {
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { }
    applyTheme(t);
  }
  function initTheme() {
    applyTheme(getTheme());
    var btn = document.getElementById('btnTheme');
    if (btn) {
      btn.onclick = function () {
        var cur = document.body.classList.contains('dark') ? 'light' : 'dark';
        setTheme(cur);
      };
    }
    if (g.matchMedia) {
      var mq = g.matchMedia('(prefers-color-scheme: dark)');
      var h = function () { if (getTheme() === 'auto') applyTheme('auto'); };
      if (mq.addEventListener) mq.addEventListener('change', h);
      else if (mq.addListener) mq.addListener(h);
    }
  }

  /* ---------- 导航高亮 ---------- */
  function initNav() {
    var path = location.pathname;
    var links = document.querySelectorAll('.nav-links a[data-nav]');
    Array.prototype.forEach.call(links, function (a) {
      var key = a.getAttribute('data-nav');
      var on = false;
      if (key === 'home') on = /\/(index\.html)?$/.test(path) || /\/Chat\/?$/.test(path);
      else on = path.indexOf('/' + key + '/') >= 0;
      if (on) a.classList.add('on');
    });
  }

  /* ---------- 下载区：按当前设备自动适配 ----------
     Q-Chat-S-138：原来六个平台卡片平铺，手机用户要在最底下翻才能找到
     "安卓"，Windows 用户也一样 —— 真正属于他的那一个埋在最不显眼处。

     ★ 但**不能只显示命中那一个**：
       平台识别靠 UA，而 UA 会骗人（iPadOS 13+ 伪装成 Macintosh、
       部分安卓浏览器自称 Linux、某些国产 ROM 改 UA）。
       一旦判错就把其他平台藏起来，用户真的就找不回来了 ——
       "自动适配"变成"自动挡路"。

       所以做法是：命中那张**排最前 + 加醒目边框 + 打「推荐给你」标**，
       其余照常可见、顺序不变、次位排后。
       判对了省事，判错了也能一眼看到自己要的那个。

     ⚠ 识别不出（未知浏览器）时落到 web（网页版）——
       它是唯一对任何设备都成立的选择，不会把人指到装不上的包上。 */
  function detectPlat() {
    var ua = navigator.userAgent || '';
    /* ⚠ iPadOS 13+ 的 UA 写成 Macintosh，但它是触屏 ——
       不判 touch 的话，iPad 会拿到 macOS 的 dmg，装不上。 */
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    if (/Windows/i.test(ua)) return 'win';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
    if (/Linux/i.test(ua)) return 'linux';
    return 'web';
  }

  function initPlatform() {
    var grid = document.querySelector('.grid');
    if (!grid) return;
    var cards = grid.querySelectorAll('.card[data-plat]');
    if (!cards.length) return;

    var mine = detectPlat();
    var hit = null;
    Array.prototype.forEach.call(cards, function (c) {
      if (c.getAttribute('data-plat') === mine) hit = c;
    });
    if (!hit) return;

    /* 排到最前。用 prepend 而不是重排全部 ——
       其余卡片的相对顺序不该被这个功能改变。 */
    grid.insertBefore(hit, grid.firstChild);

    hit.classList.add('plat-mine');
    var tag = document.createElement('span');
    tag.className = 'plat-tag';
    tag.textContent = '推荐给你';
    var h = hit.querySelector('h3');
    if (h) h.appendChild(tag);
  }

  /* ---------- Supabase 配置（贴吧用） ---------- */
  var CFG_KEY = 'wxlg_sb_cfg';
  /* 内置默认后端：打开即用。publishable key 按设计可公开，
     真正的边界是站点保护密码 + 服务端鉴权。禁止换成 secret key。 */
  var DEFAULT_URL = 'https://pimryrsxkwyafmponegp.supabase.co';
  var DEFAULT_KEY = 'sb_publishable_jPrK6j5l9NGbnLKcytTegg_di1njO8t';

  function loadCfg() {
    try {
      var c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      if (c && c.url && c.key) return c;
    } catch (e) { }
    return { url: DEFAULT_URL, key: DEFAULT_KEY };
  }
  function saveCfg(url, key) {
    localStorage.setItem(CFG_KEY, JSON.stringify({
      url: String(url || '').replace(/\/+$/, ''), key: key || ''
    }));
  }
  function cfgOn() { var c = loadCfg(); return !!(c && c.url && c.key); }

  /* 统一身份：读取聊天室登录时写入的会话 token。
     键名与 chat/js/sb.js 保持一致（wxlg_sb_token），
     两个页面共用一条会话 —— 在聊天室登录后，贴吧即可发帖。 */
  var TOK_KEY = 'wxlg_sb_token';
  function sessionToken() {
    try {
      return sessionStorage.getItem(TOK_KEY) || localStorage.getItem(TOK_KEY) || '';
    } catch (e) { return ''; }
  }
  function hasSession() { return !!sessionToken(); }

  /* 统一请求：走 REST，会话用 x-session 头 */
  function rpc(name, params) {
    var c = loadCfg();
    if (!c) return Promise.reject(new Error('未配置后端'));
    /* 必须带 x-session：服务端的 cur_token() 从请求头取会话，
       不带则所有需要登录的 RPC 一律判定为未登录。 */
    var h = { apikey: c.key, 'Content-Type': 'application/json' };
    var t = sessionToken();
    if (t) h['x-session'] = t;
    return fetch(c.url + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: h,
      body: JSON.stringify(params || {})
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t);
          throw new Error(m ? m[1].replace(/\\"/g, '"') : ('请求失败 ' + r.status));
        });
      }
      var ct = r.headers.get('content-type') || '';
      if (r.status === 204 || !ct) return null;
      return ct.indexOf('json') >= 0 ? r.json() : r.text();
    });
  }

  g.Site = {
    initTheme: initTheme, setTheme: setTheme, getTheme: getTheme,
    initNav: initNav,
    loadCfg: loadCfg, saveCfg: saveCfg, cfgOn: cfgOn, rpc: rpc,
    hasSession: hasSession, sessionToken: sessionToken
  };

  document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    initNav();
    initPlatform();
  });
})(window);
