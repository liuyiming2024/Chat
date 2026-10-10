/* ------------------------------------------------------------------
 * notify.js —— 消息通知与免打扰
 *
 * 三端共用一套逻辑：
 *   网页      → Web Notification
 *   桌面版    → 同样是 Web Notification（Electron 支持），点击后聚焦窗口
 *   安卓 APK  → Capacitor 的本地通知插件（WebView 的通知不可靠）
 *
 * 设计上最要紧的一条：**免打扰绝不能静默吞掉提示还让人以为坏了。**
 * 一旦全局免打扰、时段免打扰或某个房间被静音生效，界面上必须有可见标识，
 * 否则用户只会觉得"通知没做出来"。所以这里对外暴露 state()，
 * 由 app.js 在界面上渲染状态条。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var KEY = 'wxlg_notify_v1';
  var DEF = {
    enabled: true,     // 总开关
    preview: true,     // 通知里显示消息内容（关掉只显示"新消息"）
    sound: true,       // 提示音
    dnd: false,        // 全局免打扰
    quiet: false,      // 时段免打扰
    qFrom: 23,         // 起始小时
    qTo: 7,            // 结束小时
    rooms: {}          // 按房间静音：{roomId: true}
  };

  var cfg = load();
  var onOpen = null;        // 点击通知后的回调，由 app.js 注入
  var lastTitle = '';

  function load() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || '{}');
      var c = {};
      for (var k in DEF) c[k] = (k in o) ? o[k] : DEF[k];
      if (!c.rooms || typeof c.rooms !== 'object') c.rooms = {};
      return c;
    } catch (e) { return JSON.parse(JSON.stringify(DEF)); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { }
  }
  function get(k) { return cfg[k]; }
  function set(k, v) { cfg[k] = v; save(); }

  /* ---------------- 运行环境 ---------------- */
  function isNative() {
    return !!(g.Capacitor && g.Capacitor.isNativePlatform && g.Capacitor.isNativePlatform());
  }
  function isElectron() {
    return !!(g.navigator && /Electron/i.test(g.navigator.userAgent || ''));
  }
  function supported() {
    return isNative() || typeof g.Notification !== 'undefined';
  }

  /* 权限状态：granted / denied / default / unsupported */
  function permission() {
    if (isNative()) return localStorage.getItem('wxlg_notify_perm') || 'default';
    if (typeof g.Notification === 'undefined') return 'unsupported';
    return g.Notification.permission;
  }

  function request(cb) {
    if (isNative()) {
      var LN = g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.LocalNotifications;
      if (!LN) { localStorage.setItem('wxlg_notify_perm', 'unsupported'); cb && cb('unsupported'); return; }
      LN.requestPermissions().then(function (r) {
        var p = (r && (r.display === 'granted' || r.display === 'prompt')) ? 'granted' : 'denied';
        localStorage.setItem('wxlg_notify_perm', p);
        cb && cb(p);
      }).catch(function () {
        localStorage.setItem('wxlg_notify_perm', 'denied');
        cb && cb('denied');
      });
      return;
    }
    if (typeof g.Notification === 'undefined') { cb && cb('unsupported'); return; }
    if (g.Notification.requestPermission.length > 0 || /Safari|iPhone|iPad/.test(navigator.userAgent)) {
      /* 老版 Safari 只支持回调形式 */
      g.Notification.requestPermission(function (p) { cb && cb(p); });
    } else {
      g.Notification.requestPermission().then(function (p) { cb && cb(p); });
    }
  }

  /* ---------------- 免打扰判定 ---------------- */
  function hour() { return new Date().getHours(); }

  /* 跨零点的时间段：23→7 表示 23:00 到次日 07:00 */
  function inQuiet() {
    if (!cfg.quiet) return false;
    var h = hour(), a = cfg.qFrom * 1, b = cfg.qTo * 1;
    if (a === b) return false;
    return a < b ? (h >= a && h < b) : (h >= a || h < b);
  }

  function roomMuted(rid) { return !!(cfg.rooms && cfg.rooms[rid]); }
  function setRoomMuted(rid, on) {
    if (!cfg.rooms) cfg.rooms = {};
    if (on) cfg.rooms[rid] = true; else delete cfg.rooms[rid];
    save();
  }

  /* 当前是否处于"完全不打扰"状态 */
  function quiet() {
    if (!cfg.enabled) return 'off';       // 总开关关了
    if (cfg.dnd) return 'dnd';
    if (inQuiet()) return 'hours';
    return '';
  }

  /* ---------------- 提示音 ----------------
   * 用 WebAudio 生成短音，不依赖任何素材文件，离线也能响。
   * 全程 try/catch：音频上下文在部分环境会被策略拦掉，失败就当没声音。 */
  function beep() {
    if (!cfg.sound) return;
    try {
      var AC = g.AudioContext || g.webkitAudioContext;
      if (!AC) return;
      var ctx = beep.ctx || (beep.ctx = new AC());
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      var o = ctx.createOscillator(), gain = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
      o.connect(gain); gain.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.17);
    } catch (e) { }
  }

  /* ---------------- 发通知 ---------------- */
  function fire(title, body, rid) {
    if (isNative()) {
      var LN = g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.LocalNotifications;
      if (LN) {
        LN.schedule({
          notifications: [{
            title: title,
            body: body,
            id: Math.floor(Math.random() * 1000000),
            extra: { room: rid }
          }]
        }).catch(function () { });
        return;
      }
    }
    if (typeof g.Notification === 'undefined') return;
    try {
      var n = new g.Notification(title, {
        body: body,
        tag: 'chat-' + (rid || ''),      // 同一房间只保留最新一条，不刷屏
        renotify: true,
        icon: 'icons/icon-192.png'
      });
      n.onclick = function () {
        try { g.focus(); } catch (e) { }
        /* 桌面版：请求主进程把窗口提到前台（最小化了也要恢复） */
        try {
          if (g.ElectronBridge && g.ElectronBridge.focus) g.ElectronBridge.focus();
        } catch (e) { }
        if (onOpen) onOpen(rid);
        n.close();
      };
      /* 8 秒自动收起，避免堆积在通知中心 */
      setTimeout(function () { try { n.close(); } catch (e) { } }, 8000);
    } catch (e) { }
  }

  /* 新消息入口。info: {roomId, roomName, fromName, text, mine} */
  function incoming(info) {
    if (!info || info.mine) return;
    if (!cfg.enabled || cfg.dnd || inQuiet()) return;
    if (roomMuted(info.roomId)) return;

    beep();

    /* 正盯着这个房间看的时候不弹 —— 弹了是打扰不是提醒 */
    var visible = !g.document.hidden && g.document.hasFocus();
    if (visible && info.roomId === currentRoom()) return;

    /* 拿不到授权不是"什么都不做"的理由 —— 声音和标题闪烁不依赖授权。
       原实现在这里直接 return，未授权的用户完全感知不到新消息。 */
    if (permission() !== 'granted') { return; }

    var title = (info.roomName || '新消息');
    if (info.fromName) title = info.fromName + (info.roomName ? ' · ' + info.roomName : '');
    var body = cfg.preview ? (info.text || '新消息') : '新消息';
    if (body.length > 60) body = body.slice(0, 60) + '…';
    fire(title, body, info.roomId);
  }

  /* 由 app.js 注入：当前房间 id */
  var curRoomFn = function () { return ''; };
  function currentRoom() { try { return curRoomFn(); } catch (e) { return ''; } }
  function bindRoom(fn) { curRoomFn = fn; }

  /* ---------------- 未读角标与标题闪烁 ----------------
   * 这是"没在盯着这个页面"时唯一能看见的提醒，所以必须做到位。
   *
   * 分三层，从弱到强：
   *   ① 静态计数  (3) 聊天室 —— 一直显示
   *   ② 标题闪烁 —— 未读且页面在后台时，在两条标题之间来回切
   *   ③ 桌面通知 —— 需要授权，拿不到授权时①②照常工作
   *
   * 主流聊天工具都是这个思路：通知权限是可选项，不是前提。
   * 之前的实现把"没授权"当成"什么都不做"，所以用户会觉得通知毫无作用。 */
  var flashTimer = null, flashOn = false, baseTitle = '聊天室';
  var FLASH_A = '', FLASH_B = '';

  function setBaseTitle(t) { baseTitle = t || '聊天室'; }

  function setUnread(n) {
    try { if (g.__baseTitle) baseTitle = g.__baseTitle; } catch (e) { }
    n = n || 0;

    /* ① 静态计数 */
    var label = n > 0 ? '(' + (n > 99 ? '99+' : n) + ') ' : '';
    FLASH_A = label + baseTitle;

    /* ② 只在"页面确实在后台"时才闪 —— 正盯着看还闪是骚扰 */
    var hidden = false;
    try { hidden = g.document.hidden; } catch (e) { }
    stopFlash();
    if (n > 0 && hidden) startFlash();
    else apply(FLASH_A);

    /* 标签页图标红点 */
    drawFavicon(n);

    /* 桌面版：任务栏角标 */
    try {
      if (g.ElectronBridge && g.ElectronBridge.setBadge) g.ElectronBridge.setBadge(n);
    } catch (e) { }
  }

  function apply(t) {
    if (t === lastTitle) return;
    try { g.document.title = t; } catch (e) { }
    lastTitle = t;
  }

  /* ---------------- 标签页 favicon 红点 ----------------
   * 这是"没在看这个页面"时最有效的信号。
   *
   * 浏览器标签那么窄，标题文字会被截断成一两个词，闪烁未必看得见；
   * 但图标右上角一个红点，一眼就能扫到 —— 主流聊天工具在网页端都这么做。
   *
   * 用 canvas 现场画，不引外部图片，离线也能用。 */
  var canvas = null, faviconLink = null, origIcon = null;

  function drawFavicon(n) {
    try {
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = canvas.height = 32;
      }
      var c = canvas.getContext('2d');
      if (!c) return;
      c.clearRect(0, 0, 32, 32);

      /* 底：和站点图标一致的圆角蓝块 + 两条白线 */
      c.fillStyle = '#3b7ff2';
      roundRect(c, 0, 0, 32, 32, 7);
      c.fill();
      c.strokeStyle = '#fff';
      c.lineWidth = 2.4;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(7, 11); c.lineTo(23, 11);
      c.moveTo(7, 16); c.lineTo(18, 16);
      c.stroke();

      /* 红点：有未读才画 */
      if (n > 0) {
        c.fillStyle = '#e5453a';
        c.beginPath();
        c.arc(24, 8, 7, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#fff';
        c.font = 'bold 10px sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(n > 9 ? '9+' : String(n), 24, 8.5);
      }

      if (!faviconLink) {
        var links = document.getElementsByTagName('link');
        for (var i = 0; i < links.length; i++) {
          if (links[i].getAttribute('rel') === 'icon') { faviconLink = links[i]; break; }
        }
        if (!faviconLink) {
          faviconLink = document.createElement('link');
          faviconLink.rel = 'icon';
          document.head.appendChild(faviconLink);
        }
        origIcon = faviconLink.href;
      }
      faviconLink.href = canvas.toDataURL('image/png');
    } catch (e) { }
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function restoreFavicon() {
    try { if (faviconLink && origIcon) faviconLink.href = origIcon; } catch (e) { }
  }

  /* @我 的优先级高于普通未读 —— 主流聊天工具都是这么分级的 */
  function setFlashText(txt) { FLASH_B = txt || ''; }

  function startFlash() {
    if (flashTimer) return;
    if (!FLASH_B) FLASH_B = '💬 你有新消息';
    flashTimer = setInterval(function () {
      flashOn = !flashOn;
      apply(flashOn ? FLASH_B : FLASH_A);
    }, 900);
  }
  function stopFlash() {
    if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
    flashOn = false;
  }

  /* 回到前台立刻停闪并恢复正常标题 */
  function onFocus() {
    stopFlash();
    apply(FLASH_A);
    /* 已经回到前台了，红点没意义 —— 但不清掉会一直挂着，看着像还有未读 */
    restoreFavicon();
  }

  g.Notifier = {
    get: get, set: set, save: save,
    cfg: function () { return cfg; },
    supported: supported, permission: permission, request: request,
    quiet: quiet, inQuiet: inQuiet,
    roomMuted: roomMuted, setRoomMuted: setRoomMuted,
    incoming: incoming, bindRoom: bindRoom,
    setUnread: setUnread, setBaseTitle: setBaseTitle, setFlashText: setFlashText,
    onFocus: onFocus, isNative: isNative, isElectron: isElectron,
    set onOpen(fn) { onOpen = fn; }
  };
})(window);
