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
  /* isOn 不能只看模块变量：loadCfg() 从没被自动调用过，
     所以 url/key 一直是 null → isOn() 恒 false → 在线模式永远不生效。
     这里惰性加载一次。 */
  var cfgLoaded = false;
  function ensureCfg() { if (!cfgLoaded) { cfgLoaded = true; loadCfg(); } return !!url && !!key; }
  function isOn() { ensureCfg(); return !!url && !!key; }
  function clearCfg() { url = key = null; ls(CFG_KEY, null); dropSession(); }

  /* ---------------- HTTP ----------------
   * 新版 publishable key（sb_publishable_...）不是 JWT，
   * 只能放 apikey 头；放进 Authorization: Bearer 会被网关当 JWT 解析而报 Invalid JWT。
   * 用户身份另用 x-session 头（服务端 sessions 表校验），不依赖 PostgREST 解析 JWT。
   */
  function headers(json) {
    var h = { apikey: key };
    /* 用 token() 而不是 ss(TOK_KEY)：会话同时写在 localStorage（跨页面共享），
       只读 sessionStorage 会在新标签页里丢掉会话。 */
    var t = token();
    if (t) h['x-session'] = t;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  /* RPC 超时。
     ⚠ 原来是裸 fetch（E-050），弱网/断网时会永久挂起：
     界面停在"处理中…"，既不成功也不失败，用户只能刷新。
     有超时至少能给出"网络超时，请重试"这种能指导下一步的话。

     超时要有区分：拉取（读）可以等久一点，
     写操作（发消息）用户盯着，等太久更难受。 */
  var RPC_TIMEOUT_MS = 20000;

  function rpc(name, params) {
    if (!isOn()) return Promise.reject(new Error('未配置 Supabase'));
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = null;
    var p = fetch(url + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: headers(true), body: JSON.stringify(params || {}),
      signal: ctl ? ctl.signal : undefined
    });
    if (ctl) {
      timer = setTimeout(function () {
        try { ctl.abort(); } catch (e) { }
      }, RPC_TIMEOUT_MS);
    }
    var done = function () { if (timer) clearTimeout(timer); };
    p.then(done, done);
    return p.then(function (r) {
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
    }).catch(function (e) {
      /* AbortError 是超时自己造的，得说成人话。
         不转换的话用户看到的是 "The user aborted a request"，
         完全不知道发生了什么。 */
      if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')))) {
        throw new Error('网络超时，请重试');
      }
      if (e instanceof TypeError) throw new Error('网络异常，请检查连接');
      throw e;
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

  /* ⚠ 退出登录必须同时通知服务端（E-079，考古补回）。
     服务端 `logout()` 函数**早就写好了**，但 sb.js 里**根本没有调用它的方法**，
     前端也就一次都没调过 —— 于是只清了本地两个 storage，
     服务端那条 session 继续有效到 expires_at（**14 天**）。

     而会话同时写 localStorage 的注释里明明白白写着：
     「关闭浏览器不会自动登出，靠服务端的 expires_at 兜底」。
     **既然靠服务端兜底，退出时却不通知服务端，兜底就反成了风险** ——
     用户在网吧/公用电脑点了退出，两周内任何人拿到那台机器（或那份 token 备份）
     都能继续以他的身份登录，而他以为已经退出了。

     先清本地再通知服务端：本地先清保证"界面上已经退了"，
     服务端失败也不能让本地回到已登录状态。 */
  function logout() {
    var t = token();
    dropSession();
    if (!t) return Promise.resolve(true);
    return rpc('logout', {}).then(function () { return true; })
      .catch(function (e) {
        try { console.warn('[sb] 服务端登出失败（本地已清）', e); } catch (e2) { }
        return false;
      });
  }

  /* ---------------- 站点与账号 ---------------- */


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
  /* ⚠⚠ 删掉了 statePut（Q-Chat-S-134，由 rpc-wiring 工具抓出）。

     它调用的服务端函数 `state_put` **从来就不存在** —— 一调就是 404。
     而它又被挂在导出的公开 API 上（SB.statePut），于是看起来是个能用的功能。
     **"看起来有、实际没有"比直接报错更害人**：
     报错至少能立刻发现，而这个只在真正被调用的那一刻才炸，
     且炸的时候调用方只会以为是网络问题。

     为什么服务端不该有它（online.js 里已经写明，这里不丢掉这条理由）：
     把整包状态写回服务端会**绕过全部权限校验** ——
     任何人都能把自己的一份 state 塞上去，覆盖全站。
     所以它不是"还没实现"，是**不该实现**。留着只是误导。

     注：删的是函数和导出，online.js 里那两处解释"为什么不能有 state_put"
     的注释**保留** —— 那是设计决策的记录，删了将来会有人重新想起做它。 */


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

  /* 往 storage 桶上传字节。
     桶是私有的，但策略允许"服务端刚登记过的路径"写入（见 media_upload_allowed）。
     这里用 anon key 直传，不经过我们的 RPC，避免大文件走 PostgREST 的 body 限制。 */
  function uploadToStorage(path, blob) {
    if (!isOn()) return Promise.reject(new Error('后端未配置'));
    var ep = url + '/storage/v1/object/media/' + path.split('/').map(encodeURIComponent).join('/');
    return fetch(ep, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Content-Type': (blob && blob.type) || 'application/octet-stream',
        'x-upsert': 'false'
      },
      body: blob
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error('上传失败 ' + r.status + '：' + String(t || '').slice(0, 120));
        });
      }
      return true;
    });
  }

  g.SB = {
    loadCfg: loadCfg, configure: configure, isOn: isOn, clearCfg: clearCfg,
    syncAcl: syncAcl, uploadToStorage: uploadToStorage, token: token, uid: uid, setSession: setSession, dropSession: dropSession,
    logout: logout,
    rpc: rpc,
    gateCheck: gateCheck, login: login, register: register, initSite: initSite,
    changePwd: changePwd, setGate: setGate,
    stateSeq: stateSeq, stateGet: stateGet,
    uploadMedia: uploadMedia, mediaUrl: mediaUrl
  };
})(window);
