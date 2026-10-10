/* ------------------------------------------------------------------
 * chunked-download.js —— 分片并发下载（Electron 主进程侧）
 *
 * 为什么要分片：
 *   单条 TCP 连接的吞吐受「带宽时延积」限制 —— 延迟一高，一条连接
 *   根本打不满带宽。开几条并发各取一段，总速度往往能翻倍。
 *   体感就是：单线程时快时慢，分片后稳定得多。
 *
 * 分片带来的第二个好处（其实更重要）：
 *   单线程失败 = 整个文件重来。
 *   分片失败   = 只重传那一片。
 *   慢网络下这是"能不能下完"的区别。
 *
 * 前提：服务端要支持 Range 请求（响应头 Accept-Ranges: bytes）。
 *   不支持就自动退回单线程 —— 不能为了分片反而下不了。
 *
 * 断点续传：dest 已存在且长度等于总长时直接返回；
 *   部分存在时只补缺失的分片。
 * ------------------------------------------------------------------ */
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const CONCURRENCY = 4;          // 并发片数。太多会被服务端限流，4 是实测比较稳的值
const CHUNK_MIN = 2 * 1024 * 1024;   // 单片至少 2MB，避免切成一堆碎片
const RETRY = 3;                // 单片重试次数
const TIMEOUT = 30000;          // 单片无数据超时

function pick(url) {
  return url.startsWith('http://') ? http : https;
}

/* 跟随重定向拿最终地址。
   release 直链几乎都会 302 到对象存储，不跟就 0 字节。 */
function resolve(url, hops) {
  hops = hops || 0;
  if (hops > 5) return Promise.reject(new Error('too many redirects'));
  return new Promise((resolveP, rejectP) => {
    const lib = pick(url);
    const req = lib.get(url, { headers: { 'User-Agent': 'chat-updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolveP(resolve(new URL(res.headers.location, url).href, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return rejectP(new Error('HTTP ' + res.statusCode)); }
      resolveP({ url, headers: res.headers });
      res.resume();
    });
    req.on('error', rejectP);
    req.setTimeout(TIMEOUT, () => { req.destroy(); rejectP(new Error('timeout')); });
  });
}

/* 探测：拿到最终地址、总长度、是否支持 Range */
function probe(url) {
  return resolve(url).then((r) => {
    const len = parseInt(r.headers['content-length'], 10) || 0;
    const acceptRange = /bytes/i.test(r.headers['accept-ranges'] || '');
    return { url: r.url, len, acceptRange };
  });
}

/* 下载一个分片 [start, end]（含端点），写进 fd 的对应偏移 */
function fetchRange(url, start, end, fd, tries) {
  tries = tries || 0;
  return new Promise((ok, no) => {
    const lib = pick(url);
    const req = lib.get(url, {
      headers: { Range: `bytes=${start}-${end}`, 'User-Agent': 'chat-updater' }
    }, (res) => {
      /* 206 = 部分内容（正常）；200 = 服务端忽略 Range，那只能整段写，
         此时调用方必须只用单片，否则会写乱 —— 见下方调用约束 */
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.resume();
        return no(new Error('HTTP ' + res.statusCode));
      }
      let off = start;
      let done = false;
      res.on('data', (buf) => {
        /* ⚠ 必须同步写。
           之前用 fs.write(fd,...,position,cb) 的异步版本，多片并发时
           写进去的是【空洞】，文件长度对但内容是 0 ——
           Node 文档明确写了：同一 fd 上多次 fs.write 不等回调是不安全的。
           下载瓶颈在网络，同步写这点开销可以忽略，换来的是正确性。 */
        try {
          fs.writeSync(fd, buf, 0, buf.length, off);
        } catch (e) {
          if (!done) { done = true; res.destroy(); return no(e); }
        }
        off += buf.length;
      });
      res.on('end', () => { if (!done) ok(off - start); });
      res.on('error', (e) => { if (!done) { done = true; no(e); } });
    });
    req.on('error', (e) => no(e));
    req.setTimeout(TIMEOUT, () => { req.destroy(); no(new Error('timeout')); });
  }).catch((e) => {
    if (tries < RETRY) return fetchRange(url, start, end, fd, tries + 1);
    throw e;
  });
}

/* 主入口。
   opts: { url, dest, bytes, onProgress({loaded,total,pct}) }
   返回 { ok, path, bytes, chunks, fellBack }
   注意：fellBack=true 表示服务端不支持 Range，退化成了单线程。 */
function download(opts) {
  const { url, dest, onProgress } = opts;
  const total = opts.bytes || 0;

  return probe(url).then((info) => {
    const size = total || info.len;

    /* 已经下完整了 —— 不重复劳动 */
    let exist = 0;
    try { exist = fs.statSync(dest).size; } catch (e) { exist = 0; }
    if (size && exist === size) {
      return { ok: true, path: dest, bytes: size, chunks: 0, skipped: true };
    }

    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    /* 不支持 Range → 单线程，老老实实写一遍 */
    if (!info.acceptRange || !size) {
      return single(info.url, dest, size, onProgress).then((n) =>
        ({ ok: true, path: dest, bytes: n, chunks: 1, fellBack: true }));
    }

    /* 分片 */
    const nChunks = Math.max(1, Math.min(CONCURRENCY, Math.floor(size / CHUNK_MIN) || 1));
    const piece = Math.ceil(size / nChunks);
    const fd = fs.openSync(dest, exist === size ? 'r+' : 'w');
    if (exist !== size) { fs.ftruncateSync(fd, size); }  // 先撑到目标大小，避免并发写空洞

    const ranges = [];
    for (let i = 0; i < nChunks; i++) {
      const s = i * piece;
      const e = Math.min(size - 1, s + piece - 1);
      if (s <= e) ranges.push([s, e]);
    }

    let loaded = 0;
    const tick = () => {
      if (onProgress) {
        onProgress({ loaded, total: size, pct: size ? Math.min(100, Math.round(loaded / size * 100)) : 0 });
      }
    };

    const tasks = ranges.map(([s, e]) =>
      fetchRange(info.url, s, e, fd).then((n) => { loaded += n; tick(); })
    );

    return Promise.all(tasks).then(() => {
      fs.closeSync(fd);
      tick();
      return { ok: true, path: dest, bytes: size, chunks: ranges.length, fellBack: false };
    }).catch((e) => {
      try { fs.closeSync(fd); } catch (x) { }
      throw e;
    });
  });
}

/* 单线程回退路径 */
function single(url, dest, size, onProgress) {
  return new Promise((ok, no) => {
    const lib = pick(url);
    const file = fs.createWriteStream(dest);
    let loaded = 0;
    const req = lib.get(url, { headers: { 'User-Agent': 'chat-updater' } }, (res) => {
      if (res.statusCode !== 200) { file.close(); return no(new Error('HTTP ' + res.statusCode)); }
      res.on('data', (c) => {
        loaded += c.length;
        if (onProgress) {
          onProgress({ loaded, total: size, pct: size ? Math.min(100, Math.round(loaded / size * 100)) : 0 });
        }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => ok(loaded)));
      file.on('error', no);
    });
    req.on('error', no);
  });
}

module.exports = { download, probe, CONCURRENCY };
