/* ------------------------------------------------------------------
 * update.js —— 版本检查 + 多镜像下载
 *
 * 为什么要有多个源：
 *   单个源的下载速度时快时慢，某些网络下根本连不上。
 *   所以客户端自己测一遍，选最快的那个，源挂了自动切下一个。
 *
 * 清单在线维护：
 *   客户端只认一个【清单文件的原始地址】（raw / 对象存储的直链），
 *   真正的下载地址写在清单里。这样换源、加源都不用更新客户端 ——
 *   改一次清单，所有已安装的客户端下一次检查就生效。
 *
 * 重要：清单里的 url 必须是【文件直链】，不能是网页地址。
 *   网页地址下载下来是 HTML，不是安装包。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  /* 清单地址。必须是能直接拿到 JSON 的原始地址。
     多写几个：第一个拿不到就换下一个 —— 连清单本身也可能被墙。 */
  var MANIFEST_URLS = [
    'https://raw.githubusercontent.com/liuyiming2024/Chat/main/chat/update/manifest.json',
    'https://liuyiming2024.github.io/Chat/chat/update/manifest.json'
  ];

  var CACHE_KEY = 'wxlg_update_cache';
  var CACHE_TTL = 6 * 3600 * 1000;   // 6 小时内不重复联网查

  function fetchText(url, timeout) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; reject(new Error('timeout')); } }, timeout || 8000);
      var ctl;
      if (typeof AbortController !== 'undefined') {
        ctl = new AbortController();
      }
      fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .then(function (s) { clearTimeout(timer); if (!done) { done = true; resolve(s); } })
        .catch(function (e) { clearTimeout(timer); if (!done) { done = true; reject(e); } });
    });
  }

  /* 依次尝试每个清单地址，第一个成功的就用 */
  function loadManifest() {
    var i = 0;
    function next() {
      if (i >= MANIFEST_URLS.length) return Promise.reject(new Error('all manifest sources failed'));
      var url = MANIFEST_URLS[i++];
      return fetchText(url, 8000).then(function (txt) {
        var m = JSON.parse(txt);
        m.__from = url;
        return m;
      }).catch(next);
    }
    return next();
  }

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (!c || !c.at || Date.now() - c.at > CACHE_TTL) return null;
      return c.manifest;
    } catch (e) { return null; }
  }

  function writeCache(m) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), manifest: m }));
    } catch (e) { }
  }

  /* 平台识别。只认大类，不猜细分 —— 猜错比不猜更糟。 */
  function platform() {
    if (g.ElectronBridge && g.ElectronBridge.isApp) {
      var p = navigator.platform || '';
      if (/win/i.test(p)) return 'win';
      if (/mac/i.test(p)) return 'mac';
      return 'linux';
    }
    var ua = navigator.userAgent || '';
    if (/android/i.test(ua)) return 'android';
    if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
    if (/win/i.test(ua)) return 'win';
    if (/mac/i.test(ua)) return 'mac';
    if (/linux/i.test(ua)) return 'linux';
    return 'unknown';
  }

  function cmpVer(a, b) {
    var pa = String(a || '').replace(/^v/, '').split('.').map(Number);
    var pb = String(b || '').replace(/^v/, '').split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  /* 对一组候选源做测速。
     方式：各自发一个带 range 的小请求，先回来的最快。
     拿不到长度信息也不影响排序 —— 我们要的是"谁先响应"。 */
  function pickFastest(urls) {
    if (!urls || urls.length <= 1) return Promise.resolve(urls ? urls[0] : null);
    return Promise.race(urls.map(function (u) {
      return new Promise(function (resolve) {
        var ctl; if (typeof AbortController !== 'undefined') ctl = new AbortController();
        var t0 = Date.now();
        fetch(u, { method: 'GET', headers: { Range: 'bytes=0-1024' }, signal: ctl ? ctl.signal : undefined })
          .then(function (r) {
            if (!r.ok && r.status !== 206) throw new Error('bad');
            resolve({ url: u, ms: Date.now() - t0 });
          })
          .catch(function () { resolve(null); });
        setTimeout(function () { try { ctl && ctl.abort(); } catch (e) { } }, 6000);
      });
    })).then(function (winner) {
      if (!winner) return urls[0];   // 全失败就退回第一个，让用户至少能点
      return winner.url;
    });
  }

  /* 检查更新。返回 {hasUpdate, latest, current, notes, asset}
     force=true 忽略缓存 */
  function check(currentVersion, force) {
    var cached = force ? null : readCache();
    var p = cached ? Promise.resolve(cached) : loadManifest().then(function (m) { writeCache(m); return m; });

    return p.then(function (m) {
      var plat = platform();
      var latest = m.latest || {};
      var cur = String(currentVersion || m.minVersion || '0.0.0');
      var has = cmpVer(latest.version, cur) > 0;

      /* 取本平台的资产；没有就给 null（iOS 属于这一类） */
      var asset = null;
      if (latest.assets && latest.assets[plat]) asset = latest.assets[plat];

      return {
        hasUpdate: has && !!asset,
        latest: latest.version,
        current: cur,
        notes: latest.notes || '',
        asset: asset,
        platform: plat,
        mirrors: (m.mirrors && m.mirrors[plat]) || (asset ? asset.mirrors : null) || [],
        manifest: m
      };
    });
  }

  /* 拿到一个能直接下载的直链。
     会先测速，选最快的源。返回 Promise<string> */
  function resolveDownload(assetOrMirrors) {
    var urls = assetOrMirrors && assetOrMirrors.mirrors ? assetOrMirrors.mirrors : assetOrMirrors;
    if (!urls || !urls.length) return Promise.reject(new Error('no download source'));
    return pickFastest(urls);
  }

  /* ---------- 网页端分片下载 ----------
     网页端没有文件系统，但可以用 Range 并行拉取分片再拼成 Blob。
     目的和桌面端一样：单条连接打不满带宽，分片能提速；
     且单片失败只需重传该片，不必整个文件重来。

     注意内存：桌面端是边下边写盘，网页端只能全装在内存里。
     所以分片数按文件大小收着来，避免小内存设备上崩掉。 */
  function downloadChunked(url, opts) {
    opts = opts || {};
    var bytes = opts.bytes || 0;
    var onProgress = opts.onProgress || function () { };
    var concurrency = opts.concurrency || 4;

    return new Promise(function (resolve, reject) {
      probe(url).then(function (info) {
        var size = bytes || info.len;
        if (!size || !info.acceptRange) {
          /* 不支持 Range 就整段拉，别硬分 */
          return fetch(url).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.blob();
          }).then(function (b) {
            onProgress({ loaded: b.size, total: b.size, pct: 100 });
            resolve({ blob: b, chunks: 1, fellBack: true });
          });
        }

        var piece = Math.ceil(size / concurrency);
        var parts = [];
        for (var i = 0; i < concurrency; i++) {
          var s0 = i * piece;
          var e0 = Math.min(size - 1, s0 + piece - 1);
          if (s0 <= e0) parts.push([s0, e0]);
        }

        var loaded = 0;
        function tick() {
          onProgress({ loaded: loaded, total: size, pct: Math.round(loaded / size * 100) });
        }

        Promise.all(parts.map(function (r) {
          return fetchRange(url, r[0], r[1]).then(function (buf) {
            loaded += buf.length;
            tick();
            return { start: r[0], buf: buf };
          });
        })).then(function (chunks) {
          chunks.sort(function (a, b) { return a.start - b.start; });
          var out = new Uint8Array(size);
          var off = 0;
          chunks.forEach(function (c) {
            out.set(new Uint8Array(c.buf), off);
            off += c.buf.length;
          });
          tick();
          resolve({ blob: new Blob([out]), chunks: chunks.length, fellBack: false });
        }).catch(reject);
      }).catch(reject);
    });
  }

  function probe(url) {
    return fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } })
      .then(function (r) {
        var cr = r.headers.get('content-range') || '';
        var m = cr.match(/\/(\d+)$/);
        var len = m ? parseInt(m[1], 10) : (parseInt(r.headers.get('content-length'), 10) || 0);
        return { len: len, acceptRange: r.status === 206 || /bytes/i.test(r.headers.get('accept-ranges') || '') };
      });
  }

  function fetchRange(url, start, end, tries) {
    tries = tries || 0;
    return fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } })
      .then(function (r) {
        if (r.status !== 206 && r.status !== 200) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .catch(function (e) {
        if (tries < 3) return fetchRange(url, start, end, tries + 1);
        throw e;
      });
  }

  function fmtSize(n) {
    if (!n) return '';
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  /* 给一组源测速并排好序，返回最快的那个 + 全部结果（界面上要显示速度对比）。
     拿不到速度信息也不影响 —— 我们要的是"谁先响应"。 */
  function bestSource(sources) {
    var urls = (sources || []).map(function (s) {
      return typeof s === 'string' ? s : (s.url || s);
    });
    if (!urls.length) return Promise.resolve(null);
    return Promise.all(urls.map(function (u) {
      var t0 = Date.now();
      var ctl; if (typeof AbortController !== 'undefined') ctl = new AbortController();
      var timer = setTimeout(function () { try { ctl && ctl.abort(); } catch (e) { } }, 6000);
      return fetch(u, { method: 'GET', headers: { Range: 'bytes=0-1024' }, signal: ctl && ctl.signal })
        .then(function (r) { clearTimeout(timer); if (!r.ok && r.status !== 206) throw 0;
          return { url: u, ms: Date.now() - t0 }; })
        .catch(function () { clearTimeout(timer); return null; });
    })).then(function (rs) {
      var ok2 = rs.filter(Boolean).sort(function (a, b) { return a.ms - b.ms; });
      if (!ok2.length) return null;
      return { url: ok2[0].url, ranked: ok2 };
    });
  }

  g.Updater = {
    fmtSize: fmtSize,
    bestSource: bestSource,
    downloadChunked: downloadChunked,
    probe: probe,
    check: check,
    platform: platform,
    resolveDownload: resolveDownload,
    pickFastest: pickFastest,
    cmpVer: cmpVer,
    loadManifest: loadManifest,
    MANIFEST_URLS: MANIFEST_URLS
  };
})(window);
