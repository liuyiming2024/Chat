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
  function toast(msg, type) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.className = 'toast show' + (type ? ' toast-' + type : '');
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2200);
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
    box.querySelector('.modal-x').onclick = close;
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    var cancelBtn = box.querySelector('[data-act="cancel"]');
    var okBtn = box.querySelector('[data-act="ok"]');
    if (cancelBtn) cancelBtn.onclick = close;
    if (okBtn) okBtn.onclick = function () {
      if (!opts.onOk || opts.onOk(body) !== false) close();
    };
    if (opts.onOpen) opts.onOpen(body);
    var first = body.querySelector('input,textarea,select');
    if (first) setTimeout(function () { first.focus(); }, 30);
    return { close: close, body: body };
  }

  function confirm(text, onOk) {
    return modal({ title: '确认', body: '<div class="pad">' + esc(text) + '</div>', okText: '确定', onOk: onOk });
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
    lb = document.createElement('div');
    lb.className = 'lb-wrap';
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
    lb.appendChild(media);
    lb.appendChild(bar);
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
    var d = new Date(ts), now = new Date();
    var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return hm;
    var y = new Date(now - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }
  function fmtFull(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
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
    return d;
  }

  g.UI = {
    esc: esc, toast: toast, modal: modal, confirm: confirm, prompt: prompt,
    lightbox: lightbox, closeLightbox: closeLightbox,
    fmtTime: fmtTime, fmtFull: fmtFull, avatar: avatar
  };
})(window);
