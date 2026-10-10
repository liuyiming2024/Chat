/* ------------------------------------------------------------------
 * updater.js —— 检查更新 + 多镜像测速下载
 *
 * 三个设计要点：
 *
 * 1. 清单在线维护
 *    版本与下载地址都从 update.json 读，不硬编码在客户端里。
 *    换源、换版本改那个文件就行，不用重新发布应用。
 *
 * 2. 只认文件直链
 *    下载地址必须是 .exe / .dmg / .apk / AppImage 结尾的【文件】，
 *    不能是 /releases/latest 这种网页 —— 后者下载到的是 HTML 页面。
 *    地址由服务端的 mirrors.tpl 拼出来，而不是客户端猜。
 *
 * 3. 多源测速，自动切换
 *    单一源时快时慢甚至不可达。客户端对每个源探测前若干字节计时，
 *    选最快的开始下载；中途失败自动切下一个源。
 *
 * 只负责"告知 + 提供下载"，不静默替换正在运行的程序。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  /* 清单本身的地址也要有多个 —— 清单拉不到，更新功能就整体失效 */
  var MANIFEST_URLS = [
    'https://liuyiming2024.github.io/Chat/update.json',
    './update.json',
    '../update.json'
  ];

  var PROBE_BYTES = 65536;     /* 测速取样大小 */
  var PROBE_TIMEOUT = 6000;    /* 单个源超时 */

  function t(k, v) { return g.I18N ? g.I18N.t(k, v) : k; }

  /* 当前版本：桌面版由 preload 注入，网页版用清单里的即可 */
  function currentVersion() {
    if (g.ElectronBridge && g.ElectronBridge.version) return g.ElectronBridge.version;
    return null;
  }

  /* 探测平台，决定该下哪个文件 */
  function platform() {
    if (g.ElectronBridge && g.ElectronBridge.isApp) {
      var p = navigator.platform || '';
      if (/Win/i.test(p)) return 'win';
      if (/Mac/i.test(p)) return 'mac';
      if (/Linux/i.test(p)) return 'linux';
    }
    var ua = navigator.userAgent;
    if (/Android/i.test(ua)) return 'android';
    if (/Win/i.test(ua)) return 'win';
    if (/Mac/i.test(ua)) return 'mac';
    if (/Linux/i.test(ua)) return 'linux';
    return 'win';
  }

  /* 拉取清单。多个地址依次尝试，全失败才放弃。
     为什么清单也要多源：清单本身托管在 Pages 上，也可能访问不到。 */
  function fetchManifest() {
    var i = 0;
    function next() {
      if (i >= MANIFEST_URLS.length) return Promise.reject(new Error('manifest unreachable'));
      var url = MANIFEST_URLS[i++];
      return fetch(url, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('bad status'); return r.json(); })
        .catch(function () { return next(); });
    }
    return next();
  }

  /* 展开某个源的实际下载地址 */
  function expand(tpl, tag, file) {
    return tpl.replace('{tag}', encodeURIComponent(tag)).replace('{file}', file);
  }

  /* 对单个源测速：只取前 PROBE_BYTES 字节计时。
     注意用 Range 请求，避免把整个大文件拉下来只为测速。 */
  function probe(url) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var done = false;
      function fin(ok, bytes) {
        if (done) return;
        done = true;
        if (!ok) return resolve(null);
        var ms = Math.max(1, Date.now() - t0);
        resolve({ url: url, ms: ms, speed: bytes / ms * 1000 });
      }
      var ctl;
      if (typeof AbortController !== 'undefined') {
        ctl = new AbortController();
        setTimeout(function () { try { ctl.abort(); } catch (e) { } }, PROBE_TIMEOUT);
      }
      fetch(url, { headers: { Range: 'bytes=0-' + (PROBE_BYTES - 1) }, signal: ctl && ctl.signal })
        .then(function (r) {
          /* 服务端不支持 Range 时返回 200 且是整个文件，
             那也算通，只是别真读完 —— 直接取消 */
          if (!r.ok && r.status !== 206) return fin(false);
          var reader = r.body && r.body.getReader();
          if (!reader) return fin(true, PROBE_BYTES);
          var got = 0;
          (function pump() {
            reader.read().then(function (res) {
              if (res.done) return fin(true, got || PROBE_BYTES);
              got += (res.value && res.value.length) || 0;
              if (got >= PROBE_BYTES) { try { reader.cancel(); } catch (e) { } return fin(true, got); }
              pump();
            }).catch(function () { fin(true, got || PROBE_BYTES); });
          })();
        })
        .catch(function () { fin(false); });
    });
  }

  /* 对所有源并发测速，返回按速度排序的结果 */
  function rankSources(urls) {
    return Promise.all(urls.map(probe)).then(function (rs) {
      return rs.filter(Boolean).sort(function (a, b) { return b.speed - a.speed; });
    });
  }

  function fmtSize(n) {
    if (!n) return '';
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  function cmpVer(a, b) {
    var pa = String(a || '').replace(/^v/, '').split('.').map(Number);
    var pb = String(b || '').replace(/^v/, '').split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
  }

  /* 主入口：检查更新。
     返回 {hasUpdate, version, file, size, sources} 或 {hasUpdate:false} */
  function check() {
    return fetchManifest().then(function (m) {
      var plat = platform();
      var f = m.files && m.files[plat];
      if (!f) return { hasUpdate: false, reason: 'no file for ' + plat };

      var tag = m.version;
      var mine = currentVersion();
      var hasUpdate = mine ? cmpVer(tag, mine) : false;

      var urls = (m.mirrors || []).map(function (mm) {
        return { id: mm.id, name: mm.name, url: expand(mm.tpl, tag, f.file) };
      });

      return {
        hasUpdate: hasUpdate,
        version: tag,
        current: mine,
        notes: m.notes && (m.notes[g.I18N && g.I18N.cur() || 'zh'] || m.notes.zh),
        file: f.file,
        size: f.size,
        sources: urls
      };
    });
  }

  /* 选出最快的源（真正下载前调一次） */
  function bestSource(sources) {
    return rankSources(sources.map(function (s) { return s.url; })).then(function (ranked) {
      if (!ranked.length) return null;
      var best = ranked[0];
      var hit = sources.filter(function (s) { return s.url === best.url; })[0];
      return { source: hit || sources[0], ranked: ranked, speed: best.speed };
    });
  }

  g.Updater = {
    check: check,
    bestSource: bestSource,
    rankSources: rankSources,
    platform: platform,
    fmtSize: fmtSize,
    currentVersion: currentVersion
  };
})(window);
