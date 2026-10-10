/* ------------------------------------------------------------------
 * bridge.js —— 网页端探测本机客户端
 *
 * 桌面版运行时会在 127.0.0.1:37821 开一个小服务。这里去问一句
 * "你现在登录的是谁"，拿到票据后交给服务端换会话 —— 免输账号密码。
 *
 * 三条必须遵守的原则：
 *   1. 探测失败要【完全静默】。绝大多数用户没装桌面版，
 *      每次打开都弹一个"连接失败"是纯粹的骚扰。
 *   2. 超时要短（1.2 秒）。没装客户端时端口会立刻拒绝，但慢网络下
 *      也可能挂住，不能让用户等着。
 *   3. 票据只在本页内存里，用完即弃，不写 localStorage。
 *
 * 注意：拿到的只是"身份"，门禁（保护密码）依然要过 ——
 * 这两套凭据互不替代。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var PORT = 37821;
  var URL_IDENTITY = 'http://127.0.0.1:' + PORT + '/identity';
  var TIMEOUT = 1200;

  /* 探测。返回 Promise，resolve 出 {nick, code} 或 null（没装 / 没登录 / 超时）。 */
  function probe() {
    return new Promise(function (resolve) {
      var done = false;
      function fin(v) { if (!done) { done = true; resolve(v); } }

      var timer = setTimeout(function () { fin(null); }, TIMEOUT);

      var ctl;
      if (typeof AbortController !== 'undefined') {
        ctl = new AbortController();
        setTimeout(function () { try { ctl.abort(); } catch (e) { } }, TIMEOUT);
      }

      fetch(URL_IDENTITY, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        signal: ctl ? ctl.signal : undefined
      }).then(function (r) {
        if (!r.ok) { fin(null); return; }
        return r.json();
      }).then(function (j) {
        clearTimeout(timer);
        /* 客户端没登录时 nick 为空 —— 那不算是"可以直接进" */
        if (j && j.nick && j.code) fin({ nick: j.nick, code: j.code });
        else fin(null);
      }).catch(function () {
        clearTimeout(timer);
        fin(null);   // 静默：没装客户端是常态，不是错误
      });
    });
  }

  /* 当前页就在 Electron 里（桌面版）时不需要探测 */
  function isApp() {
    return !!(g.ElectronBridge && g.ElectronBridge.isApp);
  }

  g.Bridge = { probe: probe, isApp: isApp, PORT: PORT };
})(window);
