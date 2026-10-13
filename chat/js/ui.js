/* ------------------------------------------------------------------
 * ui.js —— 通用界面组件：Toast / 模态框 / 确认框 / 图片视频预览灯箱
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  /* ⚠ 原来签名只有 (msg, type)，而代码里有 4 处传第三个参数当时长
     （如 toast('...', 'err', 6000)）—— **被静默忽略**。
     调用方以为设了 6 秒，实际仍是默认 2.2 秒，
     长提示一闪而过，用户根本没读完。这类"参数传了没用"
     不会报错，只有对比实现和调用才会发现。

     所以补上第三个参数：ms（默认 2200；传 0 表示常驻，直到被下一次覆盖）。
     并返回元素，方便调用方主动关掉"正在…"这类进度提示。 */
  function toast(msg, type, ms) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      /* ⚠ 必须挂进 .toast-wrap（E-096，考古找回）。
         CSS 里 .toast-wrap 写了完整定位（fixed / top 18px / 居中 / z-index 1200 /
         pointer-events:none），而 .toast 本身**只有颜色、没有任何定位**。
         原来直接 appendChild 到 body —— 提示条是 body 最后一个普通 div，
         掉在页面最底部，用户做完全部操作都看不到反馈在哪。

         更讽刺的是 CSS 注释专门写了「提示层不该拦截点击，吞掉点击表现为
         点了没反应」，定位写好了却没人用，这条注释也就白写了。

         顺带：包一层容器后 pointer-events:none 才真的生效，
         提示条不再吞掉下方内容的点击。 */
      var tw = document.querySelector('.toast-wrap');
      if (!tw) {
        tw = document.createElement('div');
        tw.className = 'toast-wrap';
        document.body.appendChild(tw);
      }
      tw.appendChild(el);
    }
    el.className = 'toast show' + (type ? ' toast-' + type : '');
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    var dur = (typeof ms === 'number' && ms >= 0) ? ms : 2200;
    if (dur > 0) {
      toastTimer = setTimeout(function () { el.className = 'toast'; }, dur);
    }
    return el;
  }

  /* 模态框：opts {title, body(HTML或节点), okText, cancelText, onOk, wide} */
  function modal(opts) {
    var wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    var box = document.createElement('div');
    box.className = 'modal' + (opts.wide ? ' modal-wide' : '');
    box.innerHTML =
      '<div class="modal-head"><span>' + esc(opts.title || '') + '</span>' +
      '<button class="modal-x" type="button">×</button></div>' +
      '<div class="modal-body"></div>' +
      '<div class="modal-foot">' +
      (opts.cancelText === null ? '' : '<button class="btn ghost" data-act="cancel">' + esc(opts.cancelText || '取消') + '</button>') +
      (opts.okText === null ? '' : '<button class="btn primary" data-act="ok">' + esc(opts.okText || '确定') + '</button>') +
      '</div>';
    var body = box.querySelector('.modal-body');
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    function close() { wrap.remove(); }
    var cancelBtn = box.querySelector('[data-act="cancel"]');
    var okBtn = box.querySelector('[data-act="ok"]');
    if (opts.onOpen) opts.onOpen(body);
    var first = body.querySelector('input,textarea,select');
    if (first) setTimeout(function () { first.focus(); }, 30);
    /* ⚠ Esc 关闭。灯箱有，模态框原来没有 ——
       不一致的结果是：用户养成了按 Esc 关掉大图的习惯，
       在对话框上按 Esc 却没反应，只能伸手去点"取消"。
       对话框比灯箱更常用，更该支持。
       关闭时要连同监听器一起摘掉，否则每开一个框就多挂一个。 */
    function onEsc(e) { if (e.key === 'Escape') { close(); } }
    document.addEventListener('keydown', onEsc);
    var origClose = close;
    close = function () {
      document.removeEventListener('keydown', onEsc);
      origClose();
    };
    box.querySelector('.modal-x').onclick = close;
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    /* ⚠ onCancel 必须真的被调用（E-073，考古补回）。
       全仓只有 exportDialog 一处传了 onCancel（导出纯文本），
       而这里原本写的是 cancelBtn.onclick = close —— **onCancel 一次都没执行过**。
       用户点「导出文本」按钮，窗口关了，什么都没发生，也不报错。

       只挂在"取消按钮"上，不挂到 Esc / × / 点遮罩：
       后三者是"直接关掉"的语义，不该触发"导出"这类业务副作用。 */
    if (cancelBtn) cancelBtn.onclick = function () {
      if (opts.onCancel) { try { opts.onCancel(body); } catch (e) { } }
      close();
    };
    if (okBtn) okBtn.onclick = function () {
      if (!opts.onOk || opts.onOk(body) !== false) close();
    };
    /* ⚠ setTitle 必须返回（E-103，考古找回）。
       调用方 checkUpdateUI 里写了 mo.setTitle(...)，而这里原本只返回
       { close, body } —— 「检查更新」弹窗一旦查出有更新就抛 TypeError，
       界面永远停在「正在检查…」，用户以为没更新。
       这种"调用方写了、提供方没有"的断链不崩溃、只静默失效。

       标题是 innerHTML 生成的 .modal-head span，没有直接引用，
       所以这里要查一次 —— 别想当然以为有个现成的 titleEl 变量。

       考古时发现这条条目被整批覆盖丢失过，问题也就一直没修 ——
       条目丢了，就等于这个问题从未被提出过。 */
    function setTitle(t) {
      var el = box.querySelector('.modal-head span');
      if (el) el.textContent = t;
    }
    return { close: close, body: body, setTitle: setTitle };
  }

  /* ⚠ 第三个参数 onCancel 必须透传（S-117，考古补回）。
     原来 confirm 只接受 (text, onOk)，**丢弃了所有后续参数**，
     而 modal 本身是支持 onCancel 的（且它的 onCancel 曾一度从未被调用，见 E-073）。
     调用方写了第二个回调却永远不会执行，也不报错。 */
  function confirm(text, onOk, onCancel, opts) {
    opts = opts || {};
    return modal({
      title: opts.title || '确认',
      body: '<div class="pad">' + esc(text) + '</div>',
      okText: opts.okText || '确定',
      cancelText: opts.cancelText === undefined ? '取消' : opts.cancelText,
      onOk: onOk,
      onCancel: onCancel
    });
  }

  function prompt(title, label, dflt, onOk, opts) {
    opts = opts || {};
    return modal({
      title: title,
      body: '<div class="pad">' +
        '<label class="field-label">' + esc(label) + '</label>' +
        '<input class="field" type="' + (opts.password ? 'password' : 'text') + '" value="' + esc(dflt || '') + '">' +
        (opts.hint ? '<div class="field-hint">' + esc(opts.hint) + '</div>' : '') +
        '</div>',
      onOk: function (body) {
        var v = body.querySelector('input').value;
        if (opts.required !== false && !v.trim()) { toast('不能为空'); return false; }
        onOk(v.trim());
      }
    });
  }

  /* ---------- 图片 / 视频预览灯箱 ---------- */
  var lb = null;
  function lightbox(src, kind, name) {
    closeLightbox();
    /* ⚠ 原来 className 写 'lb-wrap'（E-057）。
       而 CSS 里 .lightbox 才是那个 fixed + 黑底 88% + z-index 1100 + flex 居中的浮层；
       .lb-wrap 只是 position:relative + max-width —— 没有定位、没有背景、没有层级。
       结果是：预览图**插在页面流里**（通常在最底部），没有遮罩、不居中，
       用户点开图什么也没看到，只会觉得"点了没反应"。

       正确做法是两层：外层 .lightbox 负责遮罩与居中，内层 .lb-wrap 负责尺寸。 */
    lb = document.createElement('div');
    lb.className = 'lightbox';
    var inner = document.createElement('div');
    inner.className = 'lb-wrap';
    var media;
    if (kind === 'video') {
      media = document.createElement('video');
      media.src = src; media.controls = true; media.autoplay = true;
      media.className = 'lb-media';
    } else {
      media = document.createElement('img');
      media.src = src; media.className = 'lb-media';
    }
    var bar = document.createElement('div');
    bar.className = 'lb-bar';
    bar.innerHTML = '<span>' + esc(name || (kind === 'video' ? '视频' : '图片')) + '</span>' +
      '<span class="lb-acts">' +
      '<a class="lb-btn" download href="' + esc(src) + '">下载</a>' +
      '<button class="lb-btn" data-act="close">关闭 (Esc)</button></span>';
    inner.appendChild(media);
    inner.appendChild(bar);
    lb.appendChild(inner);
    /* 点遮罩（最外层空白处）关闭。加了 inner 之后这条依然成立：
       只有点在 inner 之外的区域，e.target 才等于 lb。 */
    lb.addEventListener('click', function (e) { if (e.target === lb) closeLightbox(); });
    bar.querySelector('[data-act="close"]').onclick = closeLightbox;
    document.addEventListener('keydown', escHandler);
    document.body.appendChild(lb);
  }
  function escHandler(e) { if (e.key === 'Escape') closeLightbox(); }
  function closeLightbox() {
    if (lb) { lb.remove(); lb = null; }
    document.removeEventListener('keydown', escHandler);
  }

  /* ---------- 时间 ---------- */
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ts) {
    /* ⚠ 原来不判断有效性：ts 是 undefined / 空串 / 非法字符串时
       new Date() 得到 Invalid Date，toDateString() 返回 "Invalid Date"，
       最后拼出 "NaN月NaN日 NaN:NaN" 这种东西显示在消息旁边。
       消息时间戳来自服务端、localStorage、导入文件，哪一路都可能缺字段。
       宁可显示"时间未知"，也不要显示一串 NaN ——
       后者用户会以为自己客户端坏了。 */
    var d = new Date(ts), now = new Date();
    if (isNaN(d.getTime())) return '时间未知';
    var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return hm;
    var y = new Date(now - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }
  /* 日期分隔线专用。
     ⚠ 原来分隔线直接调 fmtTime(m.ts)，而 fmtTime 遇到"今天"只返回 "14:30"。
       分隔线的职责是告诉你"下面这些是**哪一天**的"，
       显示一个时刻完全答非所问 —— 用户看到一条写着 14:30 的横线，
       只会以为那是条时间戳，不知道它是在分天。
       而更早的日期又显示成"10月13日 14:30"，同一个元素两种含义，更乱。

       分隔线只说日期：今天 / 昨天 / 具体日期 / 跨年带年份。 */
  function fmtDay(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '时间未知';
    var now = new Date();
    var sameDay = function (a, b) { return a.toDateString() === b.toDateString(); };
    if (sameDay(d, now)) return '今天';
    var y = new Date(now.getTime() - 86400000);
    if (sameDay(d, y)) return '昨天';
    if (d.getFullYear() === now.getFullYear()) {
      return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function fmtFull(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '时间未知';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /* 自定义头像：userId -> dataURL。
     ⚠ 原来无上限。头像动辄几十 KB 的 dataURL，
       成员多、房间多的站点一路涨下去，内存只增不减 ——
       而且都是同一个页面生命周期内再也用不到的数据。
       给个上限，超了就把最早放进去的丢掉（简单 FIFO，够用）。 */
  var avCache = {};
  var AV_MAX = 60;
  function setAvatarCache(uid, url) {
    if (url) {
      avCache[uid] = url;
      var ks = Object.keys(avCache);
      if (ks.length > AV_MAX) { for (var i = 0; i < ks.length - AV_MAX; i++) delete avCache[ks[i]]; }
    } else delete avCache[uid];
  }

  function avatar(user, size) {
    var name = (user && user.nick) ? user.nick : '?';
    var ch = name.trim().slice(0, 1).toUpperCase();
    var hue = 0;
    for (var i = 0; i < name.length; i++) hue = (hue * 31 + name.charCodeAt(i)) % 360;
    var d = document.createElement('div');
    d.className = 'avatar' + (size ? ' avatar-' + size : '');
    d.style.background = 'hsl(' + hue + ',52%,52%)';
    d.textContent = ch;
    if (user && user.role === 'owner') d.classList.add('avatar-owner');
    if (user && user.role === 'admin') d.classList.add('avatar-admin');

    /* 自定义头像：优先用已加载的缓存图 */
    var cid = user && user.avatarId;
    if (cid && avCache[cid]) {
      d.style.backgroundImage = 'url(' + avCache[cid] + ')';
      d.style.backgroundSize = 'cover';
      d.textContent = '';
      d.classList.add('avatar-img');
    } else if (cid && g.Media && g.Media.get) {
      g.Media.get(cid).then(function (u) {
        if (!u) return;
        avCache[cid] = u;
        d.style.backgroundImage = 'url(' + u + ')';
        d.style.backgroundSize = 'cover';
        d.textContent = '';
        d.classList.add('avatar-img');
      }).catch(function () { });
    }
    return d;
  }

  /* 取一个 sprite 图标的 DOM 节点。
     界面上的图形一律走 SVG sprite，不用 emoji ——
     emoji 在不同系统上长得不一样（Android 的 🔔 和 iOS 的完全两个样），
     而且在部分 Windows 上直接显示成方框。 */
  function svgIcon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + name);
    svg.appendChild(use);
    return svg;
  }

  /* 关掉最上面那层 modal。
     ⚠⚠ 原来这里查的是 '.modal-mask'，而 modal() 建的容器类名是 '.modal-wrap' ——
        CSS 里也根本没有 .modal-mask 这个东西。
        结果：querySelectorAll 永远返回空列表，closeModal() 什么都不做。
        app.js 里 @提及面板点人名后就是靠它关闭的 ——
        **选完人，文本插进去了，面板却关不掉**，只能去点"关闭"。
        更麻烦的是 app.js 里还有个同款的 closeTop()，犯的是同一个错。

        为什么这个 bug 能活这么久：调用处写了 `g.UI.closeModal && ...`，
        函数存在、不报错、只是没效果 —— "有保护就不报错"的写法把缺失藏住了。 */
  function closeModal() {
    var ms = document.querySelectorAll('.modal-wrap');
    if (ms && ms.length) {
      var last = ms[ms.length - 1];
      if (last.parentNode) last.parentNode.removeChild(last);
    }
  }

  g.UI = {
    closeModal: closeModal,
    svgIcon: svgIcon,
    esc: esc, toast: toast, modal: modal, confirm: confirm, prompt: prompt,
    lightbox: lightbox, closeLightbox: closeLightbox,
    fmtTime: fmtTime, fmtFull: fmtFull, fmtDay: fmtDay, avatar: avatar, setAvatarCache: setAvatarCache
  };
})(window);
