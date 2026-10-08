/* ------------------------------------------------------------------
 * sb.js —— Supabase 访问层（本地 server.py 与 GitHub Pages 上线版共用）
 *
 * 设计要点（与"本地/线上架构必须一致"的要求对应）：
 *   1. 只有一套客户端：本文件。file://、python server.py、GitHub Pages
 *      三种打开方式调用的是完全相同的方法、走完全相同的接口。
 *   2. 不引入任何 CDN / 第三方 SDK，纯 fetch 实现，避免版权与离线问题。
 *   3. 明文只出不进：密码一律由服务端（pgcrypto bcrypt）处理，
 *      前端从不拿到任何人的 pwdHash / pwdSalt。
 *   4. 认证靠服务端签发的 HMAC token（sessionStorage 保存），
 *      anon key 即使被公开，没有站点保护密码也拿不到数据。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var CFG_KEY = 'wxlg_sb_cfg';
  var TOK_KEY = 'wxlg_sb_token';
  var UID_KEY = 'wxlg_sb_uid';
  var url = null, key = null;

  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
    catch (e) { }
    return null;
  }
  function ss(k, v) {
    try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); }
    catch (e) { }
    return null;
  }

  /* ---------------- 配置 ----------------
   * 内置默认后端：打开即用，无需手动填写。
   *
   * 为什么可以硬编码 —— publishable key（sb_publishable_...）按设计就是公开的：
   * 任何前端项目的 JS 包里都躺着一个，用 DevTools 谁都能翻出来。
   * 它本身不是凭证，真正的边界是站点保护密码 + 服务端函数内的鉴权。
   * Supabase 官方文档也是这么用的（等价于 NEXT_PUBLIC_SUPABASE_ANON_KEY）。
   *
   * ⚠ 绝对不要在这里放 service_role / secret key（sb_secret_...），
   *   那个绕过一切权限，放进前端等于把数据库交出去。
   */
  var DEFAULT_URL = 'https://pimryrsxkwyafmponegp.supabase.co';
  var DEFAULT_KEY = 'sb_publishable_jPrK6j5l9NGbnLKcytTegg_di1njO8t';

  function loadCfg() {
    try {
      var c = JSON.parse(ls(CFG_KEY) || 'null');
      if (c && c.url && c.key) { url = c.url.replace(/\/+$/, ''); key = c.key; return true; }
    } catch (e) { }
    /* 没手动配过 → 用内置的。用户仍可在设置里改（改了就存 localStorage，优先用手动值） */
    url = DEFAULT_URL; key = DEFAULT_KEY;
    return true;
  }
  function configure(u, k) {
    url = String(u || '').replace(/\/+$/, '');
    key = k || '';
    ls(CFG_KEY, JSON.stringify({ url: url, key: key }));
    return !!url && !!key;
  }
  function isOn() { return !!url && !!key; }
  function clearCfg() { url = key = null; ls(CFG_KEY, null); dropSession(); }

  /* ---------------- HTTP ----------------
   * 新版 publishable key（sb_publishable_...）不是 JWT，
   * 只能放 apikey 头；放进 Authorization: Bearer 会被网关当 JWT 解析而报 Invalid JWT。
   * 用户身份另用 x-session 头（服务端 sessions 表校验），不依赖 PostgREST 解析 JWT。
   */
  function headers(json) {
    var h = { apikey: key };
    var t = ss(TOK_KEY);
    if (t) h['x-session'] = t;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  function rpc(name, params) {
    if (!isOn()) return Promise.reject(new Error('未配置 Supabase'));
    return fetch(url + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: headers(true), body: JSON.stringify(params || {})
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t);
          throw new Error(m ? m[1].replace(/\\"/g, '"') : ('请求失败 ' + r.status));
        });
      }
      var ct = r.headers.get('content-type') || '';
      if (r.status === 204 || !ct) return null;
      if (ct.indexOf('json') < 0) return r.text();
      return r.json();
    });
  }

  /* ---------------- 会话 ---------------- */
  /* 会话存储：同时写 localStorage 与 sessionStorage。
     为什么改用 localStorage —— 统一身份要求跨页面可见。
     贴吧、聊天室是两个独立页面，sessionStorage 按标签页隔离，
     从聊天室登录后在贴吧页面读不到 token，统一身份就不成立。
     代价：关闭浏览器不会自动登出，靠服务端的 expires_at 兜底（14 天）。 */
  function setSession(token, uid) {
    ss(TOK_KEY, token || null); ss(UID_KEY, uid || null);
    ls(TOK_KEY, token || null); ls(UID_KEY, uid || null);
  }
  function token() { return ss(TOK_KEY) || ls(TOK_KEY) || null; }
  function uid() { return ss(UID_KEY) || ls(UID_KEY) || null; }
  function dropSession() {
    ss(TOK_KEY, null); ss(UID_KEY, null);
    ls(TOK_KEY, null); ls(UID_KEY, null);
  }

  /* ---------------- 站点与账号 ---------------- */
  function ping() { return rpc('state_seq', {}).then(function () { return true; }); }

  function gateCheck(pwd) {
    return rpc('gate_check', { p: pwd }).then(function (t) {
      if (!t) throw new Error('保护密码错误');
      setSession(t, null);
      return t;
    });
  }
  /* 登录后向服务端拉取权威权限表，覆盖前端本地判定。
     不做这一步，前端会按本地角色渲染按钮 —— 可能与服务端不一致。 */
  function syncAcl() {
    return rpc('acl_mine', {}).then(function (j) {
      if (j && window.ACL && window.ACL.syncFromServer) window.ACL.syncFromServer(j);
      return j;
    }).catch(function () { return null; });   /* 失败不阻断登录，退回本地判定 */
  }

  function login(nick, pwd) {
    return rpc('user_login', { p_nick: nick, p_pwd: pwd }).then(function (r) {
      if (!r) throw new Error('昵称或密码错误');
      setSession(r.token, r.uid);
      return syncAcl().then(function () { return r; });
    });
  }
  function register(nick, realName, pwd) {
    return rpc('user_register', { p_nick: nick, p_real: realName, p_pwd: pwd });
  }
  function initSite(gate, nick, realName, pwd) {
    return rpc('site_init', { p_gate: gate, p_nick: nick, p_real: realName, p_pwd: pwd })
      .then(function (r) {
        if (r && r.token) setSession(r.token, r.uid);
        return syncAcl().then(function () { return r; });
      });
  }
  function changePwd(oldP, newP) { return rpc('user_password', { p_old: oldP, p_new: newP }); }
  function setGate(newP) { return rpc('gate_set', { p_new: newP }); }

  /* ---------------- 状态读写 ---------------- */
  function stateSeq() { return rpc('state_seq', {}); }
  function stateGet() { return rpc('state_get', {}); }
  function statePut(data) { return rpc('state_put', { p_data: data }); }

  /* ---------------- 媒体（Storage） ---------------- */
  function dataUrlToBlob(u) {
    var m = /^data:([^;]+);base64,(.*)$/s.exec(u) || /^data:([^;]+);base64,([\s\S]*)$/.exec(u);
    if (!m) return Promise.reject(new Error('不是合法的 data URL'));
    var bin = atob(m[2]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return Promise.resolve(new Blob([arr], { type: m[1] }));
  }
  function uploadMedia(id, dataUrl) {
    if (!isOn()) return Promise.reject(new Error('未配置 Supabase'));
    var ext = (/(data:([^;]+))/.exec(dataUrl) || [, , 'application/octet-stream'])[2];
    var mime = ext.split('/')[1] || 'bin';
    var path = id + '.' + (mime === 'jpeg' ? 'jpg' : mime);
    return dataUrlToBlob(dataUrl).then(function (blob) {
      var h = { apikey: key, 'Content-Type': blob.type, 'x-upsert': 'true' };
      var t = token();
      if (t) h['x-session'] = t;
      return fetch(url + '/storage/v1/object/media/' + path, {
        method: 'POST', headers: h, body: blob
      });
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('上传失败 ' + r.status); });
      return url + '/storage/v1/object/public/media/' + path;
    });
  }
  function mediaUrl(id, mime) {
    return url + '/storage/v1/object/public/media/' + id + '.' + (mime || 'bin');
  }

  g.SB = {
    loadCfg: loadCfg, configure: configure, isOn: isOn, clearCfg: clearCfg,
    ping: ping, syncAcl: syncAcl, token: token, uid: uid, setSession: setSession, dropSession: dropSession,
    gateCheck: gateCheck, login: login, register: register, initSite: initSite,
    changePwd: changePwd, setGate: setGate,
    stateSeq: stateSeq, stateGet: stateGet, statePut: statePut,
    uploadMedia: uploadMedia, mediaUrl: mediaUrl
  };
})(window);
