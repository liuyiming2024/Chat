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
    if (btn) btn.textContent = dark ? '☀' : '🌙';
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

  /* ---------- Supabase 配置（贴吧用） ---------- */
  var CFG_KEY = 'wxlg_sb_cfg';
  function loadCfg() {
    try {
      var c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      if (c && c.url && c.key) return c;
    } catch (e) { }
    return null;
  }
  function saveCfg(url, key) {
    localStorage.setItem(CFG_KEY, JSON.stringify({
      url: String(url || '').replace(/\/+$/, ''), key: key || ''
    }));
  }
  function cfgOn() { var c = loadCfg(); return !!(c && c.url && c.key); }

  /* 统一请求：走 REST，会话用 x-session 头 */
  function rpc(name, params) {
    var c = loadCfg();
    if (!c) return Promise.reject(new Error('未配置后端'));
    return fetch(c.url + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: { apikey: c.key, 'Content-Type': 'application/json' },
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
    loadCfg: loadCfg, saveCfg: saveCfg, cfgOn: cfgOn, rpc: rpc
  };

  document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    initNav();
  });
})(window);
