/* ------------------------------------------------------------------
 * net.js —— 运行环境自检 + 可选 C++/WASM 加速
 *
 * 【重要】本模块不参与任何业务分支：
 *   全项目只有一套运行架构（见 sync.js），不存在"本地模式 / 后端模式"的切换。
 *   这里只做两件事：
 *     1) 探测当前部署形态（file:// 直开 / http 静态托管 / GitHub Pages），
 *        结果仅用于 /env 面板的展示与提示，不改变任何数据流；
 *     2) 尝试加载 native/accel.wasm 加速密码哈希；缺失或失败一律静默回退到
 *        纯 JS 实现（sha256.js），功能与结果完全一致。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  /* ---------------- 部署形态探测（仅供展示） ---------------- */
  function deploy() {
    var p = (g.location && g.location.protocol) || '';
    var host = (g.location && g.location.hostname) || '';
    var kind;
    if (p === 'file:') kind = '本地文件直开（file://）';
    else if (/\.github\.io$/i.test(host)) kind = 'GitHub Pages 静态托管';
    else if (host === 'localhost' || host === '127.0.0.1') kind = '本地静态服务（server.py）';
    else if (p === 'https:') kind = 'HTTPS 静态托管';
    else kind = p ? (p + '//' + host) : '未知';
    return { protocol: p, host: host, kind: kind };
  }

  /* ---------------- 可选 C++ / WASM 加速 ---------------- */
  function loadAccel() {
    if (typeof WebAssembly === 'undefined') return Promise.resolve(false);
    if (typeof fetch !== 'function') return Promise.resolve(false);   // file:// 下无 fetch
    return fetch('native/accel.wasm')
      .then(function (r) {
        if (!r.ok) throw 0;
        return WebAssembly.instantiateStreaming(r, {
          env: {
            memory: new WebAssembly.Memory({ initial: 2 }),
            js_log: function (p, n) { console.log('[accel]', p, n); }
          }
        });
      })
      .then(function (res) {
        var e = res.instance.exports;
        if (typeof e.sha256_hex !== 'function') return false;
        var mem = e.memory || res.instance.exports.memory;
        var orig = g.SHA256.hex;
        g.SHA256.hex = function (str) {
          try {
            var bytes = new TextEncoder().encode(String(str));
            var inBuf = e.accel_alloc ? e.accel_alloc(bytes.length) : 0;
            if (!inBuf) return orig(str);
            new Uint8Array(mem.buffer, inBuf, bytes.length).set(bytes);
            var hp = e.sha256_hex(inBuf, bytes.length, 0);
            var hexBytes = new Uint8Array(mem.buffer, hp, 64);
            var s = '';
            for (var i = 0; i < 64; i++) s += String.fromCharCode(hexBytes[i]);
            if (e.accel_free) e.accel_free(inBuf);
            return s;
          } catch (err) { return orig(str); }
        };
        /* 关键：把同一个 WASM 实现挂到 _wasmHex，慢哈希才会真正走加速路径。
           只替换 hex 的话，slowHash 走的是内部 core，等于空转。 */
        g.SHA256._wasmHex = g.SHA256.hex;
        g.__accel = true;
        return true;
      })
      .catch(function () { return false; });   // 静默回退
  }

  /* ---------------- 环境自检 ---------------- */
  function env() {
    var d = deploy();
    var cap = (g.Sync && g.Sync.capability) ? g.Sync.capability() : {};
    return {
      ua: navigator.userAgent,
      lang: navigator.language,
      online: navigator.onLine,
      secure: !!g.isSecureContext,
      deploy: d.kind,
      protocol: d.protocol || '—',
      host: d.host || '—',
      broadcast: !!cap.broadcast,
      syncActive: !!cap.active,
      storage: !!cap.storage,
      indexedDB: !!cap.indexedDB,
      wasm: typeof g.WebAssembly !== 'undefined',
      accel: !!g.__accel,
      crypto: !!(g.crypto && g.crypto.subtle),
      screen: g.screen.width + '×' + g.screen.height,
      dpr: g.devicePixelRatio || 1
    };
  }

  g.Net = {
    deploy: deploy,
    loadAccel: loadAccel,
    env: env
  };
})(window);
