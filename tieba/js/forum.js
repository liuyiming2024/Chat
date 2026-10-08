/* ------------------------------------------------------------------
 * forum.js —— 贴吧
 *
 * 双数据源，但**界面与数据结构完全一致**，不存在两套页面逻辑：
 *   1. 本地模式（默认）：存 localStorage，能发帖盖楼，换设备看不到。
 *   2. 数据库模式：填了 Supabase 配置后自动切换，跨设备可见。
 * 切换只影响 store 这一层，上面的渲染、交互代码只有一份。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var KEY = 'wxlg_forum';
  var NICK_KEY = 'wxlg_forum_nick';
  var state = { posts: [], view: 'list', cur: null, kw: '' };

  /* ---------------- 本地存储 ---------------- */
  function localLoad() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{"posts":[]}').posts || []; }
    catch (e) { return []; }
  }
  function localSave() {
    try { localStorage.setItem(KEY, JSON.stringify({ posts: state.posts })); } catch (e) { }
  }

  /* ---------------- 数据层：所有读写都走这里 ---------------- */
  var store = {
    mode: function () { return g.Site.cfgOn() ? 'db' : 'local'; },

    list: function () {
      if (this.mode() === 'db') {
        return g.Site.rpc('forum_list', {}).then(function (rows) {
          return (rows || []).map(function (r) {
            return {
              id: r.id, title: r.title, body: r.body, author: r.author,
              ts: Date.parse(r.created_at), replies: r.replies || []
            };
          });
        });
      }
      return Promise.resolve(localLoad().slice().sort(function (a, b) { return b.ts - a.ts; }));
    },

    requireLogin: function () {
      if (this.mode() !== 'db') return null;
      if (!g.Site || !g.Site.hasSession || g.Site.hasSession()) return null;
      return new Error('请先在聊天室登录（贴吧与聊天室共用同一账号），登录后回来刷新即可发帖。');
    },

    add: function (title, body, author) {
      if (this.mode() === 'db') {
        var e0 = this.requireLogin(); if (e0) return Promise.reject(e0);
        return g.Site.rpc('forum_post', { p_title: title, p_body: body, p_author: author })
          .then(function () { return true; });
      }
      state.posts.unshift({
        id: 'p_' + Date.now() + Math.random().toString(36).slice(2, 7),
        title: title, body: body, author: author, ts: Date.now(), replies: []
      });
      localSave();
      return Promise.resolve(true);
    },

    reply: function (pid, body, author) {
      if (this.mode() === 'db') {
        var e1 = this.requireLogin(); if (e1) return Promise.reject(e1);
        return g.Site.rpc('forum_reply', { p_post: pid, p_body: body, p_author: author })
          .then(function () { return true; });
      }
      var p = state.posts.filter(function (x) { return x.id === pid; })[0];
      if (p) {
        p.replies = p.replies || [];
        p.replies.push({
          id: 'r_' + Date.now() + Math.random().toString(36).slice(2, 7),
          body: body, author: author, ts: Date.now()
        });
        localSave();
      }
      return Promise.resolve(true);
    },

    remove: function (pid, author) {
      if (this.mode() === 'db') {
        var e2 = this.requireLogin(); if (e2) return Promise.reject(e2);
        /* 后端改为按会话身份校验（本人或管理员），不再传作者名 ——
           作者名是公开的，用它当凭证等于没有校验。 */
        return g.Site.rpc('forum_del', { p_post: pid });
      }
      state.posts = state.posts.filter(function (x) { return x.id !== pid; });
      localSave();
      return Promise.resolve(true);
    }
  };

  /* ---------------- 工具 ---------------- */
  function $ (id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmt(ts) {
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function nick() {
    var v = ($('nickInput') && $('nickInput').value.trim()) || '';
    if (v) { try { localStorage.setItem(NICK_KEY, v); } catch (e) { } return v; }
    try { return localStorage.getItem(NICK_KEY) || '匿名'; } catch (e) { return '匿名'; }
  }
  function toast(msg, kind) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);' +
      'background:' + (kind === 'err' ? '#e64340' : '#2dc100') + ';color:#fff;' +
      'padding:9px 16px;border-radius:6px;z-index:9999;font-size:14px;box-shadow:0 4px 14px rgba(0,0,0,.2)';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }
  function dialog(title, fields, onOk) {
    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.42);z-index:9000;' +
      'display:flex;align-items:center;justify-content:center;padding:16px';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--panel);border:1px solid var(--border);border-radius:8px;' +
      'padding:20px;max-width:520px;width:100%;max-height:86vh;overflow:auto';
    var html = '<h3 style="margin:0 0 14px;font-size:16px">' + esc(title) + '</h3>';
    fields.forEach(function (f) {
      html += '<label style="display:block;font-size:13px;color:var(--dim);margin:10px 0 4px">' +
        esc(f.label) + '</label>';
      if (f.type === 'textarea') {
        html += '<textarea class="field" id="f_' + f.key + '" rows="' + (f.rows || 6) +
          '" style="width:100%;resize:vertical" placeholder="' + esc(f.ph || '') + '"></textarea>';
      } else {
        html += '<input class="field" id="f_' + f.key + '" type="' + (f.type || 'text') +
          '" style="width:100%" value="' + esc(f.val || '') + '" placeholder="' + esc(f.ph || '') + '">';
      }
    });
    html += '<div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="btn-sm" data-a="cancel">取消</button>' +
      '<button class="btn-sm primary" data-a="ok">确定</button></div>';
    box.innerHTML = html;
    mask.appendChild(box);
    document.body.appendChild(mask);
    var close = function () { mask.remove(); };
    box.querySelector('[data-a=cancel]').onclick = close;
    box.querySelector('[data-a=ok]').onclick = function () {
      var vals = {};
      fields.forEach(function (f) { vals[f.key] = box.querySelector('#f_' + f.key).value; });
      if (onOk(vals) !== false) close();
    };
    mask.onclick = function (e) { if (e.target === mask) close(); };
    var first = box.querySelector('input,textarea');
    if (first) setTimeout(function () { first.focus(); }, 60);
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var mode = store.mode();
    $('modeTag').textContent = mode === 'db' ? '数据库（跨设备可见）' : '本地（仅本设备可见）';
    var tip = $('cfgTip');
    if (mode === 'local') {
      tip.style.display = '';
      tip.innerHTML = '<b>当前是本地模式：</b>你发的帖子只有这台设备能看到，' +
        '换设备或清除浏览器数据就没了。想让所有人看到同一个贴吧，' +
        '点「后端设置」填入数据库地址即可。详见 <a href="../docs/deploy.html">部署与数据指南</a>。';
    } else {
      tip.style.display = 'none';
    }

    if (state.view === 'post') { renderDetail(); return; }

    var kw = state.kw.trim().toLowerCase();
    var list = state.posts.filter(function (p) {
      if (!kw) return true;
      return (p.title + '\n' + p.body).toLowerCase().indexOf(kw) >= 0;
    });

    var host = $('postList');
    if (!list.length) {
      host.innerHTML = '<div class="empty">' + (kw ? '没有匹配的帖子' : '还没有帖子，点右上角发个新帖吧') + '</div>';
      return;
    }
    host.innerHTML = list.map(function (p) {
      return '<div class="post">' +
        '<div class="post-title"><a href="#" data-pid="' + esc(p.id) + '">' + esc(p.title) + '</a></div>' +
        '<div class="post-meta">' + esc(p.author || '匿名') + ' · ' + fmt(p.ts) +
        ' · ' + ((p.replies || []).length) + ' 条回复</div>' +
        '<div class="post-body">' + esc((p.body || '').slice(0, 150)) +
        ((p.body || '').length > 150 ? '…' : '') + '</div>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('[data-pid]'), function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        openPost(a.getAttribute('data-pid'));
      };
    });
  }

  function openPost(pid) {
    var p = state.posts.filter(function (x) { return x.id === pid; })[0];
    if (!p) return;
    state.view = 'post'; state.cur = pid;
    $('viewList').style.display = 'none';
    $('viewPost').style.display = '';
    renderDetail();
  }

  function renderDetail() {
    var p = state.posts.filter(function (x) { return x.id === state.cur; })[0];
    if (!p) { back(); return; }
    var rs = (p.replies || []).map(function (r) {
      return '<div class="reply"><div class="reply-meta">' + esc(r.author || '匿名') +
        ' · ' + fmt(r.ts) + '</div><div style="white-space:pre-wrap;word-break:break-word">' +
        esc(r.body) + '</div></div>';
    }).join('');
    $('postDetail').innerHTML =
      '<div class="post">' +
      '<div class="post-title">' + esc(p.title) + '</div>' +
      '<div class="post-meta">' + esc(p.author || '匿名') + ' · ' + fmt(p.ts) + '</div>' +
      '<div class="post-body">' + esc(p.body) + '</div>' +
      (rs || '<div style="margin-top:12px;color:var(--dim);font-size:13.5px">还没有回复</div>') +
      '</div>' +
      '<div class="panel" style="margin-top:14px">' +
      '<label style="display:block;font-size:13px;color:var(--dim);margin-bottom:6px">回复</label>' +
      '<textarea class="field" id="replyBox" rows="4" style="width:100%;resize:vertical" ' +
      'placeholder="友善地表达你的观点…"></textarea>' +
      '<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="btn-sm primary" id="btnReply">发表回复</button></div></div>';
    $('btnReply').onclick = function () {
      var b = $('replyBox').value.trim();
      if (!b) { toast('回复内容不能为空', 'err'); return; }
      var who = nick();
      store.reply(p.id, b, who).then(function () {
        $('replyBox').value = '';
        refresh(function () { renderDetail(); });
        toast('已回复', 'ok');
      }).catch(function (e) { toast('失败：' + e.message, 'err'); });
    };
  }

  function back() {
    state.view = 'list'; state.cur = null;
    $('viewPost').style.display = 'none';
    $('viewList').style.display = '';
    render();
  }

  function refresh(after) {
    store.list().then(function (rows) {
      state.posts = rows || [];
      if (after) after(); else render();
    }).catch(function (e) {
      toast('读取失败：' + e.message, 'err');
      render();
    });
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener('DOMContentLoaded', function () {
    try {
      var n = localStorage.getItem(NICK_KEY);
      if (n && $('nickInput')) $('nickInput').value = n;
    } catch (e) { }

    $('btnNew').onclick = function () {
      if (!($('nickInput').value.trim())) {
        toast('请先填一下昵称', 'err');
        $('nickInput').focus();
        return;
      }
      dialog('发新帖', [
        { key: 'title', label: '标题', ph: '例如：这道 DP 题的转移方程怎么写' },
        { key: 'body', label: '正文', type: 'textarea', rows: 8, ph: '支持换行，会原样显示' }
      ], function (v) {
        if (!v.title.trim()) { toast('标题不能为空', 'err'); return false; }
        if (!v.body.trim()) { toast('正文不能为空', 'err'); return false; }
        store.add(v.title.trim(), v.body.trim(), nick()).then(function () {
          refresh(); toast('已发布', 'ok');
        }).catch(function (e) { toast('失败：' + e.message, 'err'); });
      });
    };

    $('btnCfg').onclick = function () {
      var c = g.Site.loadCfg() || { url: '', key: '' };
      dialog('后端设置', [
        { key: 'url', label: 'Project URL', val: c.url, ph: 'https://xxxx.supabase.co' },
        { key: 'key', label: 'Publishable key', val: c.key, ph: 'sb_publishable_...' }
      ], function (v) {
        if (!v.url.trim() || !v.key.trim()) {
          if (confirm('留空将清空配置并回到本地模式（本地帖子不受影响），确定吗？')) {
            try { localStorage.removeItem('wxlg_sb_cfg'); } catch (e) { }
            refresh(); toast('已切回本地模式', 'ok');
          }
          return;
        }
        g.Site.saveCfg(v.url.trim(), v.key.trim());
        refresh(); toast('已保存，正在切换到数据库', 'ok');
      });
    };

    $('btnBack').onclick = back;
    $('searchKey').oninput = function () { state.kw = this.value; render(); };

    refresh();
  });
})(window);
