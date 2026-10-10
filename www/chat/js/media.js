/* ------------------------------------------------------------------
 * media.js —— 媒体存取
 *  图片 / 视频以 dataURL 存进 IndexedDB（不占 localStorage 的 5MB 配额），
 *  发送前自动压缩图片，避免大图撑爆存储。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var DB_NAME = 'wxlg_media', STORE = 'files', dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      if (!g.indexedDB) { res(null); return; }
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { res(null); };
    });
    return dbp;
  }

  function put(id, dataUrl) {
    return open().then(function (db) {
      if (!db) { try { localStorage.setItem('wxlg_m_' + id, dataUrl); } catch (e) { } return; }
      return new Promise(function (res) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(dataUrl, id);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      });
    });
  }

  /* 远端解析器：由 online.js 注入。
     本地 IndexedDB 里没有这条媒体时（换设备、清缓存），
     用它把 storage 里的对象换成可访问链接。 */
  var remoteResolver = null;
  function setRemoteResolver(fn) { remoteResolver = fn; }

  function get(id) {
    return open().then(function (db) {
      var local = null;
      if (!db) local = localStorage.getItem('wxlg_m_' + id);
      return new Promise(function (res) {
        if (!db) { res(local); return; }
        var tx = db.transaction(STORE, 'readonly');
        var rq = tx.objectStore(STORE).get(id);
        rq.onsuccess = function () { res(rq.result || local || null); };
        rq.onerror = function () { res(local || null); };
      });
    }).then(function (v) {
      if (v) return v;
      if (remoteResolver) {
        return Promise.resolve()
          .then(function () { return remoteResolver(id); })
          .then(function (u) { return u || null; })
          .catch(function () { return null; });
      }
      return null;
    });
  }

  /* dataURL / Blob → Blob（上传需要二进制，不能传 dataURL） */
  function toBlob(dataUrl) {
    try {
      var i = dataUrl.indexOf(',');
      var head = dataUrl.slice(0, i);
      var b64 = dataUrl.slice(i + 1);
      var mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
      var bin = atob(b64);
      var n = bin.length, u8 = new Uint8Array(n);
      for (var k = 0; k < n; k++) u8[k] = bin.charCodeAt(k);
      return new Blob([u8], { type: mime });
    } catch (e) { return null; }
  }

  function del(id) {
    return open().then(function (db) {
      if (!db) { localStorage.removeItem('wxlg_m_' + id); return; }
      return new Promise(function (res) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = function () { res(); };
      });
    });
  }

  /* ---------- 图片压缩：dataURL -> dataURL(JPEG) ---------- */
  function compressImage(dataUrl, maxSide, quality) {
    maxSide = maxSide || 1600; quality = quality || 0.82;
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height;
        var scale = Math.min(1, maxSide / Math.max(w, h));
        if (scale === 1 && dataUrl.length < 400000) { res(dataUrl); return; }
        var cw = Math.round(w * scale), chh = Math.round(h * scale);
        var c = document.createElement('canvas');
        c.width = cw; c.height = chh;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, chh);
        ctx.drawImage(img, 0, 0, cw, chh);
        try { res(c.toDataURL('image/jpeg', quality)); } catch (e) { res(dataUrl); }
      };
      img.onerror = function () { res(dataUrl); };
      img.src = dataUrl;
    });
  }

  function readFile(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('读取失败')); };
      fr.readAsDataURL(file);
    });
  }

  /* 视频首帧做封面 */
  function videoPoster(dataUrl) {
    return new Promise(function (res) {
      var v = document.createElement('video');
      v.preload = 'metadata'; v.muted = true; v.src = dataUrl;
      v.onloadeddata = function () {
        try { v.currentTime = Math.min(0.2, (v.duration || 1) / 2); } catch (e) { }
      };
      v.onseeked = function () {
        try {
          var c = document.createElement('canvas');
          c.width = Math.min(480, v.videoWidth || 320);
          c.height = Math.round(c.width * ((v.videoHeight || 240) / (v.videoWidth || 320)));
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', 0.7));
        } catch (e) { res(null); }
      };
      v.onerror = function () { res(null); };
      setTimeout(function () { res(null); }, 4000);
    });
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function dataUrlSize(d) {
    if (!d) return 0;
    var i = d.indexOf(',');
    return Math.round((d.length - i - 1) * 0.75);
  }

  g.Media = {
    put: put, get: get, del: del, setRemoteResolver: setRemoteResolver, toBlob: toBlob,
    compressImage: compressImage, readFile: readFile, videoPoster: videoPoster,
    fmtSize: fmtSize, dataUrlSize: dataUrlSize
  };
})(window);
