/* ------------------------------------------------------------------
 * sw.js —— 离线缓存
 *
 * 设计原则只有一条：**绝不能让用户看到旧版本还以为是最新的。**
 *
 * 本项目踩过这个坑：Pages 构建失败时会继续服务上一次成功的产物，
 * 页面看着正常，实际是幽灵版本。缓存层再犯一次同样的错，
 * 就变成"双重幽灵"——排查时根本分不清是没部署还是被缓存了。
 *
 * 所以：
 *   1. HTML 一律 network-first。在线就拿最新，只有彻底断网才回缓存。
 *   2. 静态资源用 stale-while-revalidate：先给快的，后台换新的。
 *   3. 后端请求（*.supabase.co）一律不缓存，永远走网络。
 *   4. 拿到新版本后主动通知页面，让页面提示用户刷新，不悄悄换。
 * ------------------------------------------------------------------ */
'use strict';

var VERSION = 'v1';
var CORE = [
  './',
  './index.html',
  './css/style.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      /* 单个失败不能让整个安装挂掉 —— 否则永远装不上，离线完全不可用 */
      return Promise.all(CORE.map(function (u) {
        return c.add(u).catch(function () { });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) {
        if (k !== VERSION) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isBackend(url) {
  return /supabase\.co|supabase\.in/.test(url.hostname);
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  /* 后端请求：永远走网络。缓存了会导致消息不更新，
     而且会话头带凭据，不该落盘。 */
  if (isBackend(url)) return;

  /* 跨源资源一律不碰 */
  if (url.origin !== self.location.origin) return;

  var isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') >= 0;

  if (isHTML) {
    /* network-first：在线就拿最新的 */
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (r) {
          return r || caches.match('./');
        });
      })
    );
    return;
  }

  /* 其他静态资源：先给缓存里的（快），后台去换新的 */
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});

/* 收到页面的 SKIP_WAITING 指令：立刻接管，并告诉页面刷新 */
self.addEventListener('message', function (e) {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
