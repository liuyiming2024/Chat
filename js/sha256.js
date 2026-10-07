/* ------------------------------------------------------------------
 * sha256.js —— 纯自研 SHA-256（无任何第三方依赖，可离线运行）
 * 提供：SHA256.hex(str) / SHA256.bytes(str) / SHA256.slowHash(pwd, salt)
 * 用途：账号口令派生、群口令校验、消息完整性摘要
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9e9, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  var H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else {
        i++;
        c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return new Uint8Array(out);
  }

  function core(msg) {
    var l = msg.length;
    var blocks = Math.ceil((l + 9) / 64);
    var total = blocks * 64;
    var m = new Uint8Array(total);
    m.set(msg);
    m[l] = 0x80;
    var dv = new DataView(m.buffer);
    var bits = l * 8;
    dv.setUint32(total - 8, Math.floor(bits / 4294967296));
    dv.setUint32(total - 4, bits >>> 0);

    var w = new Uint32Array(64), H = H0.slice(), i, b;
    for (b = 0; b < blocks; b++) {
      for (i = 0; i < 16; i++) w[i] = dv.getUint32(b * 64 + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], gg = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & gg);
        var t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & bb) ^ (a & c) ^ (bb & c);
        var t2 = (S0 + maj) >>> 0;
        h = gg; gg = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + bb) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + gg) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32), odv = new DataView(out.buffer);
    for (i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  function toHex(bytes) {
    var s = '', i;
    for (i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    return s;
  }

  /* 口令派生：PBKDF1 风格的迭代哈希，抵制弱口令暴力枚举 */
  function slowHash(pwd, salt, rounds) {
    rounds = rounds || 4000;
    var acc = toHex(core(utf8(salt + '|' + pwd)));
    for (var i = 0; i < rounds; i++) acc = toHex(core(utf8(acc + salt + i)));
    return acc;
  }

  function randomId(n) {
    var cs = 'abcdefghijklmnopqrstuvwxyz0123456789', s = '', i;
    var buf = (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? crypto.getRandomValues(new Uint8Array(n || 12)) : null;
    for (i = 0; i < (n || 12); i++) {
      var r = buf ? buf[i] : Math.floor(Math.random() * 256);
      s += cs[r % cs.length];
    }
    return s;
  }

  g.SHA256 = {
    bytes: function (s) { return core(utf8(String(s))); },
    hex: function (s) { return toHex(core(utf8(String(s)))); },
    slowHash: slowHash,
    randomId: randomId
  };
})(window);
