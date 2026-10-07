/* ------------------------------------------------------------------
 * app.js —— 主逻辑
 *  门禁 → 登录/注册 → 会话 → 消息（文本/图片/视频/Markdown/LaTeX）
 *  → 房间（公屏 / 群聊 / 私聊）→ 权限与管理 → 命令 → 同步
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var KEY = 'wxlg_state_v1', ME_KEY = 'wxlg_me', GATE_KEY = 'wxlg_gate_ok';

  var S = null, me = null, cur = 'public';
  var unread = {}, replyTo = null, roomFilter = '';

  /* ================= 小工具 ================= */
  function $(id) { return document.getElementById(id); }
  function elc(tag, cls, txt) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (txt != null) d.textContent = txt;
    return d;
  }
  function uid(p) { return (p || 'x') + '_' + g.SHA256.randomId(10); }
  function now() { return Date.now(); }
  function nick(u) { return u ? (u.nick || '未知用户') : '未知用户'; }
  function findUser(id) { for (var i = 0; i < S.users.length; i++) if (S.users[i].id === id) return S.users[i]; return null; }
  function byNick(n) {
    n = String(n || '').replace(/^@/, '').trim().toLowerCase();
    for (var i = 0; i < S.users.length; i++) if ((S.users[i].nick || '').toLowerCase() === n) return S.users[i];
    for (i = 0; i < S.users.length; i++) if ((S.users[i].nick || '').toLowerCase().indexOf(n) === 0) return S.users[i];
    return null;
  }
  function findRoom(id) { for (var i = 0; i < S.rooms.length; i++) if (S.rooms[i].id === id) return S.rooms[i]; return null; }
  function msgs(rid) { return S.messages[rid] || (S.messages[rid] = []); }
  function touch(o) { if (o) o.updatedAt = now(); return o; }
  function hashPwd(p, salt) { return g.SHA256.slowHash(p, salt, 4000); }

  function log(act, detail, target) {
    S.logs.unshift({ id: uid('l'), ts: now(), who: me ? me.id : 'system', act: act, detail: detail || '', target: target || '' });
    if (S.logs.length > 400) S.logs.length = 400;
  }

  /* ================= 状态存取 ================= */
  function fresh() {
    return {
      version: 1, createdAt: now(), seq: 0, siteName: '洛谷·微信聊天室',
      gate: null, allowRegister: true,
      users: [], rooms: [], messages: {}, logs: []
    };
  }
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.version) return s;
    } catch (e) { }
    return null;
  }
  var pushTimer = null;
  function save(silent) {
    if (!S) return;
    S.seq = (S.seq || 0) + 1;
    /* 唯一写入路径：先落快照，再由统一同步层广播（不区分部署形态） */
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { g.UI.toast('本地存储写入失败，请清理旧图片/视频', 'err'); }
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { g.Sync.commit(S); }, 60);
    if (!silent) renderAll();
  }

  function mergeArr(a, b) {
    var m = {}, i;
    for (i = 0; i < a.length; i++) m[a[i].id] = a[i];
    for (i = 0; i < b.length; i++) {
      var x = b[i], o = m[x.id];
      if (!o) m[x.id] = x;
      else if ((x.updatedAt || x.ts || 0) > (o.updatedAt || o.ts || 0)) m[x.id] = x;
    }
    return Object.keys(m).map(function (k) { return m[k]; });
  }
  function mergeState(inS) {
    if (!inS || !inS.users) return false;
    var changed = false;
    S.users = mergeArr(S.users, inS.users || []);
    S.rooms = mergeArr(S.rooms, inS.rooms || []);
    Object.keys(inS.messages || {}).forEach(function (rid) {
      var map = {}, a = msgs(rid), b = inS.messages[rid] || [], i;
      for (i = 0; i < a.length; i++) map[a[i].id] = a[i];
      for (i = 0; i < b.length; i++) {
        var x = b[i], o = map[x.id];
        if (!o) { map[x.id] = x; changed = true; }
        else if (x.deleted && !o.deleted) { map[x.id] = x; }
      }
      S.messages[rid] = Object.keys(map).map(function (k) { return map[k]; })
        .sort(function (p, q) { return p.ts - q.ts; });
    });
    S.logs = mergeArr(S.logs || [], inS.logs || []).sort(function (p, q) { return q.ts - p.ts; }).slice(0, 400);
    if (inS.gate) S.gate = inS.gate;
    if (typeof inS.allowRegister === 'boolean') S.allowRegister = inS.allowRegister;
    if (inS.siteName) S.siteName = inS.siteName;
    if (me) { var u = findUser(me.id); if (u) me = u; }
    return true;
  }

  function initSync() {
    /* 唯一的同步入口：无论 file:// 直开、server.py 还是 GitHub Pages，
       都通过 Sync 层收敛——收到任何一份 state 都用同一套 merge 合并。 */
    g.Sync.init({
      onState: function (inS) {
        if (mergeState(inS)) renderAll();
      },
      onPatch: function () {
        /* 别的标签改了数据：重读快照并合并 */
        try {
          var raw = localStorage.getItem(KEY);
          if (raw && mergeState(JSON.parse(raw))) renderAll();
        } catch (err) { }
      }
    });
  }

  /* ================= 门禁 ================= */
  function gateHtml(inner) {
    var wrap = $('gate');
    wrap.innerHTML = '';
    var card = elc('div', 'gate-card');
    card.innerHTML = '<div class="gate-title">洛谷 · 微信聊天室</div>' +
      '<div class="gate-sub">实名社区 · 支持 Markdown 与 $LaTeX$ · 纯前端运行</div>';
    var box = elc('div', '');
    box.innerHTML = inner;
    card.appendChild(box);
    wrap.appendChild(card);
    wrap.classList.remove('hidden');
    var f = card.querySelector('input');
    if (f) setTimeout(function () { f.focus(); }, 50);
    return card;
  }

  function setupGate() {
    var card = gateHtml(
      '<div class="form-tip">首次进入：请设置<b>保护密码</b>（进入本站所需）并创建站长账号。</div>' +
      '<label class="field-label">站点保护密码</label><input class="field" id="gGate" type="password" placeholder="进入本聊天室需要的密码">' +
      '<label class="field-label">确认保护密码</label><input class="field" id="gGate2" type="password">' +
      '<div class="hr-line"></div>' +
      '<label class="field-label">站长昵称</label><input class="field" id="gNick" placeholder="例如：洛谷站长">' +
      '<label class="field-label">真实姓名（实名制）</label><input class="field" id="gReal" placeholder="例如：张三">' +
      '<label class="field-label">站长登录密码</label><input class="field" id="gPwd" type="password">' +
      '<button class="btn primary block" id="gOk">创建并进入</button>' +
      '<div class="form-note">保护密码与登录密码均经加盐慢哈希存储，不保存明文。</div>'
    );
    card.querySelector('#gOk').onclick = function () {
      var gp = card.querySelector('#gGate').value, gp2 = card.querySelector('#gGate2').value;
      var nick = card.querySelector('#gNick').value.trim();
      var real = card.querySelector('#gReal').value.trim();
      var pwd = card.querySelector('#gPwd').value;
      if (gp.length < 4) { g.UI.toast('保护密码至少 4 位'); return; }
      if (gp !== gp2) { g.UI.toast('两次保护密码不一致'); return; }
      if (!nick || !real) { g.UI.toast('请填写昵称与真实姓名'); return; }
      if (pwd.length < 4) { g.UI.toast('登录密码至少 4 位'); return; }
      var gs = g.SHA256.randomId(12), us = g.SHA256.randomId(12);
      S.gate = { hash: hashPwd(gp, gs), salt: gs };
      var u = {
        id: uid('u'), nick: nick, realName: real, pwdHash: hashPwd(pwd, us), pwdSalt: us,
        role: 'owner', perms: [], banned: false, mutedUntil: 0, bio: '站长',
        createdAt: now(), updatedAt: now(), lastSeen: now()
      };
      S.users.push(u);
      ensurePublic();
      log('init', '创建站点与站长账号 ' + nick);
      save(true);
      sessionStorage.setItem(GATE_KEY, '1');
      sessionStorage.setItem(ME_KEY, u.id);
      me = u;
      enterApp();
    };
  }

  function enterGate() {
    var card = gateHtml(
      '<div class="form-tip">本站受保护密码保护，请输入进入密码。</div>' +
      '<label class="field-label">保护密码</label><input class="field" id="gP" type="password" placeholder="请输入保护密码">' +
      '<button class="btn primary block" id="gOk">进入</button>' +
      '<div class="form-note">忘记密码？只能由管理员在服务器/浏览器本地重置（设置 → 数据 → 重置站点）。</div>'
    );
    function ok() {
      var p = card.querySelector('#gP').value;
      if (!p) { g.UI.toast('请输入密码'); return; }
      if (hashPwd(p, S.gate.salt) !== S.gate.hash) { g.UI.toast('密码错误', 'err'); return; }
      sessionStorage.setItem(GATE_KEY, '1');
      afterGate();
    }
    card.querySelector('#gOk').onclick = ok;
    card.querySelector('#gP').onkeydown = function (e) { if (e.key === 'Enter') ok(); };
  }

  function afterGate() {
    var id = sessionStorage.getItem(ME_KEY);
    if (id) { var u = findUser(id); if (u && !u.banned) { me = u; enterApp(); return; } }
    loginView();
  }

  /* ================= 登录 / 注册 ================= */
  function loginView() {
    var wrap = $('gate');
    wrap.innerHTML = '';
    var card = elc('div', 'gate-card');
    card.innerHTML =
      '<div class="gate-title">登录</div><div class="gate-sub">' + g.UI.esc(S.siteName || '洛谷·微信聊天室') + '</div>' +
      '<div class="tabs"><button class="tab on" data-t="login">登录</button><button class="tab" data-t="reg">注册</button></div>' +
      '<div id="pane"></div>';
    wrap.appendChild(card);
    wrap.classList.remove('hidden');

    function pane(t) {
      var p = card.querySelector('#pane');
      Array.prototype.forEach.call(card.querySelectorAll('.tab'), function (b) { b.classList.toggle('on', b.dataset.t === t); });
      if (t === 'login') {
        p.innerHTML =
          '<label class="field-label">昵称</label><input class="field" id="lNick" placeholder="你的昵称">' +
          '<label class="field-label">登录密码</label><input class="field" id="lPwd" type="password">' +
          '<button class="btn primary block" id="lOk">登录</button>';
        var ok = function () {
          var u = byNick(card.querySelector('#lNick').value);
          if (!u) { g.UI.toast('用户不存在', 'err'); return; }
          if (hashPwd(card.querySelector('#lPwd').value, u.pwdSalt) !== u.pwdHash) { g.UI.toast('密码错误', 'err'); return; }
          if (u.banned) { g.UI.toast('该账号已被封禁', 'err'); return; }
          sessionStorage.setItem(ME_KEY, u.id);
          me = u; touch(me); me.lastSeen = now(); save(true);
          enterApp();
        };
        card.querySelector('#lOk').onclick = ok;
        card.querySelector('#lPwd').onkeydown = function (e) { if (e.key === 'Enter') ok(); };
      } else {
        if (!S.allowRegister) {
          p.innerHTML = '<div class="form-tip">当前关闭了公开注册，请联系管理员开通账号。</div>';
          return;
        }
        p.innerHTML =
          '<label class="field-label">昵称（登录用）</label><input class="field" id="rNick" placeholder="字母/数字/中文均可">' +
          '<label class="field-label">真实姓名（实名制，公开展示）</label><input class="field" id="rReal" placeholder="例如：李四">' +
          '<label class="field-label">登录密码</label><input class="field" id="rPwd" type="password">' +
          '<label class="field-label">确认密码</label><input class="field" id="rPwd2" type="password">' +
          '<button class="btn primary block" id="rOk">注册并进入</button>';
        var rok = function () {
          var n = card.querySelector('#rNick').value.trim();
          var r = card.querySelector('#rReal').value.trim();
          var a = card.querySelector('#rPwd').value, b = card.querySelector('#rPwd2').value;
          if (!n || !r) { g.UI.toast('请填写昵称与真实姓名'); return; }
          if (byNick(n)) { g.UI.toast('昵称已被占用'); return; }
          if (a.length < 4) { g.UI.toast('密码至少 4 位'); return; }
          if (a !== b) { g.UI.toast('两次密码不一致'); return; }
          var salt = g.SHA256.randomId(12);
          var u = {
            id: uid('u'), nick: n, realName: r, pwdHash: hashPwd(a, salt), pwdSalt: salt,
            role: 'member', perms: [], banned: false, mutedUntil: 0, bio: '',
            createdAt: now(), updatedAt: now(), lastSeen: now()
          };
          S.users.push(u);
          joinRoom('public', u, true);
          log('reg', '注册账号 ' + n + '（' + r + '）');
          save(true);
          sessionStorage.setItem(ME_KEY, u.id);
          me = u;
          enterApp();
        };
        card.querySelector('#rOk').onclick = rok;
      }
    }
    Array.prototype.forEach.call(card.querySelectorAll('.tab'), function (b) {
      b.onclick = function () { pane(b.dataset.t); };
    });
    pane('login');
  }

  /* ================= 进入主界面 ================= */
  function ensurePublic() {
    if (!findRoom('public')) {
      S.rooms.unshift({
        id: 'public', name: '公屏大厅', type: 'public', desc: '所有人可见，进站自动加入',
        owner: null, admins: [], members: null, pwd: null,
        notice: '欢迎来到**公屏大厅**！\n\n- 支持 Markdown 与 `$E=mc^2$` 行内公式\n- 支持 `$$\\frac{a}{b}$$` 块级公式\n- 输入 `/help` 查看全部命令',
        muted: [], createdAt: now(), updatedAt: now()
      });
    }
  }

  function enterApp() {
    $('gate').classList.add('hidden');
    $('gate').innerHTML = '';
    $('app').classList.remove('hidden');
    ensurePublic();
    if (me.role === 'member' && !findRoom('public')) { }
    joinRoom('public', me, true);
    save(true);
    bindEvents();
    renderAll();
    g.Net.loadAccel().then(function (ok) { if (ok) g.UI.toast('已启用 C++/WASM 哈希加速', 'ok'); });
    scrollBottom();
    $('input').focus();
  }

  /* ================= 房间相关 ================= */
  function myRooms() {
    return S.rooms.filter(function (r) {
      if (r.type === 'public') return true;
      return r.members && r.members.indexOf(me.id) >= 0;
    });
  }
  function roomTitleOf(r) {
    if (r.type === 'private') {
      var other = (r.members || []).filter(function (x) { return x !== me.id; })[0];
      return nick(findUser(other));
    }
    return r.name;
  }
  function roomAvatarText(r) {
    if (r.type === 'private') return nick(findUser((r.members || []).filter(function (x) { return x !== me.id; })[0]) || {}).slice(0, 1);
    return (r.name || '群').slice(0, 1);
  }
  function membersOf(r) {
    if (r.type === 'public') return S.users.slice();
    return (r.members || []).map(findUser).filter(Boolean);
  }
  function joinRoom(rid, user, quiet) {
    var r = findRoom(rid);
    if (!r) return false;
    if (r.type === 'public') return true;
    if (r.members.indexOf(user.id) < 0) {
      r.members.push(user.id);
      touch(r);
      if (!quiet) {
        sysMsg(rid, nick(user) + ' 加入了群聊');
        log('join', nick(user) + ' 加入 ' + r.name, r.id);
      }
    }
    return true;
  }

  function sysMsg(rid, text) {
    msgs(rid).push({ id: uid('msg'), room: rid, from: 'system', type: 'system', text: text, ts: now() });
  }

  function pushMsg(m) {
    msgs(m.room).push(m);
    save();
    var atBottom = isBottom();
    renderChat();
    if (atBottom || m.from === me.id) scrollBottom();
    g.Sync.ping();   /* 通知其他标签立即读取新快照 */
  }

  function isBottom() {
    var s = $('msgScroll');
    return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
  }
  function scrollBottom() {
    var s = $('msgScroll');
    if (s) s.scrollTop = s.scrollHeight;
  }

  /* ================= 渲染 ================= */
  function renderAll() { renderMe(); renderSidebar(); renderChat(); }

  function renderMe() {
    var c = $('meCard');
    c.innerHTML = '';
    var a = g.UI.avatar(me, 'md');
    c.appendChild(a);
    var info = elc('div', 'me-info');
    info.innerHTML = '<div class="me-nick">' + g.UI.esc(me.nick) +
      '<span class="tag ' + (me.role === 'owner' ? 'green' : me.role === 'admin' ? 'blue' : 'gray') + '">' +
      g.ACL.roleName(me) + '</span></div>' +
      '<div class="me-sub">' + g.UI.esc(me.realName || '未实名') + (g.ACL.muted(me) ? ' · 禁言中' : '') + '</div>';
    c.appendChild(info);
    var edit = elc('button', 'mini-btn', '资料');
    edit.onclick = openProfile;
    c.appendChild(edit);
  }

  function renderSidebar() {
    var list = $('roomList');
    list.innerHTML = '';
    var rooms = myRooms();
    var kw = roomFilter.trim().toLowerCase();
    if (kw) rooms = rooms.filter(function (r) { return roomTitleOf(r).toLowerCase().indexOf(kw) >= 0; });
    rooms.sort(function (a, b) {
      var ta = (msgs(a.id).length ? msgs(a.id)[msgs(a.id).length - 1].ts : a.createdAt) || 0;
      var tb = (msgs(b.id).length ? msgs(b.id)[msgs(b.id).length - 1].ts : b.createdAt) || 0;
      return tb - ta;
    });
    rooms.forEach(function (r) {
      var m = msgs(r.id), last = m.length ? m[m.length - 1] : null;
      var item = elc('div', 'room-item' + (r.id === cur ? ' on' : ''));
      var av = elc('div', 'avatar room-avatar', roomAvatarText(r));
      if (r.type === 'private') av.style.background = '#5b8ff9';
      item.appendChild(av);
      var mid = elc('div', 'room-mid');
      var preview = last ? (last.type === 'system' ? last.text :
        (last.type === 'text' ? nick(findUser(last.from)) + '：' + g.MD.plain(last.text || '') :
          nick(findUser(last.from)) + '：[' + (last.type === 'video' ? '视频' : '图片') + ']')) : '还没有消息';
      if (last && last.deleted) preview = '消息已撤回';
      mid.innerHTML = '<div class="room-name">' + g.UI.esc(roomTitleOf(r)) +
        (r.type === 'group' ? '<span class="tag gray">群</span>' : r.type === 'private' ? '<span class="tag blue">私聊</span>' : '<span class="tag green">公屏</span>') +
        '</div><div class="room-preview">' + g.UI.esc(preview) + '</div>';
      item.appendChild(mid);
      var right = elc('div', 'room-right');
      if (last) right.appendChild(elc('div', 'room-time', g.UI.fmtTime(last.ts)));
      var n = unread[r.id] || 0;
      if (n > 0 && r.id !== cur) right.appendChild(elc('div', 'badge', n > 99 ? '99+' : String(n)));
      item.appendChild(right);
      item.onclick = function () { openRoom(r.id); };
      item.oncontextmenu = function (e) {
        e.preventDefault();
        roomMenu(r);
      };
      list.appendChild(item);
    });
    if (!rooms.length) list.appendChild(elc('div', 'empty-tip', '没有匹配的会话'));
  }

  function renderChat() {
    var r = findRoom(cur);
    if (!r) { cur = 'public'; r = findRoom('public'); }
    if (!r) return;
    $('roomTitle').textContent = roomTitleOf(r);
    var mem = membersOf(r);
    var sub = [];
    sub.push(r.type === 'public' ? '公屏大厅 · ' + mem.length + ' 人在线' :
      r.type === 'private' ? '私聊' : '群聊 · ' + mem.length + ' 人');
    if (r.pwd) sub.push('已加密');
    $('roomSub').textContent = sub.join(' · ');

    /* 公告 */
    var nb = $('noticeBar');
    if (nb) {
      if (r.notice) { nb.innerHTML = ''; nb.appendChild(g.MD.render(r.notice)); nb.classList.remove('hidden'); }
      else nb.classList.add('hidden');
    }

    /* 禁言提示 */
    var sp = g.ACL.canSpeak(me, r);
    var mt = $('mutedTip');
    if (!sp.ok) { mt.textContent = sp.why + '，暂时无法发言'; mt.classList.remove('hidden'); $('input').disabled = true; $('btnSend').disabled = true; }
    else { mt.classList.add('hidden'); $('input').disabled = false; $('btnSend').disabled = false; }

    /* 消息 */
    var box = $('msgScroll');
    box.innerHTML = '';
    var arr = msgs(r.id).slice(-300);
    var lastDay = '';
    arr.forEach(function (m) {
      var d = new Date(m.ts);
      var day = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
      if (day !== lastDay) {
        lastDay = day;
        box.appendChild(elc('div', 'time-sep', g.UI.fmtTime(m.ts)));
      }
      box.appendChild(renderMsg(m, r));
    });

    /* 成员面板 */
    $('memberCount').textContent = String(mem.length);
    var ml = $('memberList');
    ml.innerHTML = '';
    mem.sort(function (a, b) {
      var ra = g.ACL.roomRole(a, r), rb = g.ACL.roomRole(b, r);
      var oa = { owner: 0, roomOwner: 1, roomAdmin: 2, member: 3, guest: 4 };
      return (oa[ra] || 9) - (oa[rb] || 9);
    });
    mem.forEach(function (u) {
      var line = elc('div', 'user-line');
      line.appendChild(g.UI.avatar(u, 'sm'));
      var t = elc('div', 'user-line-main');
      t.innerHTML = '<div class="user-line-name">' + g.UI.esc(u.nick) + ' <span class="user-real">' + g.UI.esc(u.realName || '') + '</span></div>' +
        '<div class="user-line-role">' + g.ACL.roleName(u) + ' · ' + g.ACL.roomRole(u, r) + '</div>';
      line.appendChild(t);
      if (u.banned) line.appendChild(elc('span', 'tag red', '封'));
      if (g.ACL.muted(u)) line.appendChild(elc('span', 'tag orange', '禁'));
      line.onclick = function () { userCard(u, r); };
      ml.appendChild(line);
    });

    $('noticeText').innerHTML = '';
    if (r.notice) $('noticeText').appendChild(g.MD.render(r.notice));
    else $('noticeText').textContent = '暂无公告';
    $('btnEditNotice').style.display = g.ACL.can(me, 'room.notice', r) ? '' : 'none';
  }

  function renderMsg(m, r) {
    if (m.type === 'system') {
      var s = elc('div', 'sys-bubble', m.text);
      return s;
    }
    var u = findUser(m.from);
    var mine = m.from === me.id;
    var row = elc('div', 'msg-row' + (mine ? ' me' : ''));
    row.appendChild(g.UI.avatar(u, 'md'));
    var body = elc('div', 'msg-body');
    var head = elc('div', 'msg-head');
    head.innerHTML = '<span class="msg-name">' + g.UI.esc(nick(u)) + '</span>' +
      (u && u.role === 'owner' ? '<span class="tag green">站长</span>' : u && u.role === 'admin' ? '<span class="tag blue">管理</span>' : '') +
      '<span class="msg-time">' + g.UI.fmtFull(m.ts) + '</span>';
    body.appendChild(head);

    var bubble = elc('div', 'bubble');
    if (m.deleted) {
      bubble.classList.add('bubble-dead');
      bubble.textContent = mine ? '你撤回了一条消息' : '该消息已被删除';
    } else {
      if (m.replyTo) {
        var q = elc('div', 'reply-quote');
        q.innerHTML = '<b>' + g.UI.esc(nick(findUser(m.replyTo.from))) + '</b>：' +
          g.UI.esc(m.replyTo.type === 'text' ? g.MD.plain(m.replyTo.text || '') : '[' + m.replyTo.type + ']');
        bubble.appendChild(q);
      }
      if (m.type === 'text') {
        bubble.appendChild(g.MD.render(m.text || ''));
      } else if (m.type === 'image' || m.type === 'video') {
        bubble.appendChild(mediaNode(m));
      }
    }
    body.appendChild(bubble);

    /* 操作条 */
    if (!m.deleted) {
      var acts = elc('div', 'msg-acts');
      var bRep = elc('button', 'msg-act', '引用');
      bRep.onclick = function () { setReply(m); };
      acts.appendChild(bRep);
      if (m.type === 'text') {
        var bCopy = elc('button', 'msg-act', '复制');
        bCopy.onclick = function () {
          try { navigator.clipboard.writeText(m.text || ''); g.UI.toast('已复制', 'ok'); }
          catch (e) { g.UI.toast('复制失败'); }
        };
        acts.appendChild(bCopy);
      }
      if (mine && g.ACL.can(me, 'msg.recall', r)) {
        var bR = elc('button', 'msg-act', '撤回');
        bR.onclick = function () { doDelete(m, true); };
        acts.appendChild(bR);
      }
      if (g.ACL.can(me, 'msg.delete', r)) {
        var bD = elc('button', 'msg-act danger', '删除');
        bD.onclick = function () { doDelete(m, false); };
        acts.appendChild(bD);
      }
      body.appendChild(acts);
    }
    row.appendChild(body);
    return row;
  }

  function mediaNode(m) {
    var wrap = elc('div', 'media-wrap');
    var src = '';
    if (m.type === 'image') {
      var img = elc('img', 'thumb');
      img.alt = m.name || '图片';
      img.src = src || 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="#eee"/></svg>');
      img.onclick = function () { g.UI.lightbox(img.src, 'image', m.name); };
      wrap.appendChild(img);
    } else {
      var v = elc('video', 'thumb');
      v.preload = 'metadata';
      v.src = src;
      if (m.poster) v.poster = m.poster;
      v.onclick = function () { g.UI.lightbox(v.src, 'video', m.name); };
      wrap.appendChild(v);
      var play = elc('div', 'play-badge', '▶');
      play.onclick = function () { g.UI.lightbox(v.src, 'video', m.name); };
      wrap.appendChild(play);
    }
    var cap = elc('div', 'media-cap', (m.name || '媒体') + (m.size ? ' · ' + g.Media.fmtSize(m.size) : ''));
    wrap.appendChild(cap);
    /* 唯一的媒体读取路径：一律从 IndexedDB 取（任何部署形态都相同） */
    if (m.mediaId) {
      g.Media.get(m.mediaId).then(function (u) {
        if (!u) return;
        if (m.type === 'image') img.src = u; else if (!v.src) v.src = u;
      });
    }
    return wrap;
  }

  function setReply(m) {
    replyTo = { id: m.id, from: m.from, text: m.text, type: m.type };
    var bar = $('replyBar');
    bar.innerHTML = '';
    bar.appendChild(elc('span', '', '回复 ' + nick(findUser(m.from)) + '：' +
      (m.type === 'text' ? g.MD.plain(m.text || '').slice(0, 40) : '[' + m.type + ']')));
    var x = elc('button', 'mini-btn', '取消');
    x.onclick = function () { replyTo = null; bar.classList.add('hidden'); };
    bar.appendChild(x);
    bar.classList.remove('hidden');
    $('input').focus();
  }

  /* ================= 发送 ================= */
  function send() {
    var ta = $('input');
    var text = ta.value.replace(/\s+$/, '');
    if (!text) return;
    var r = findRoom(cur);
    var sp = g.ACL.canSpeak(me, r);
    if (!sp.ok) { g.UI.toast(sp.why, 'err'); return; }
    if (text.charAt(0) === '/') {
      ta.value = '';
      return command(text.slice(1), r);
    }
    ta.value = '';
    var m = {
      id: uid('msg'), room: cur, from: me.id, type: 'text', text: text,
      ts: now(), replyTo: replyTo || null
    };
    replyTo = null; $('replyBar').classList.add('hidden');
    pushMsg(m);
    ta.style.height = 'auto';
  }

  function doDelete(m, recall) {
    var r = findRoom(cur);
    m.deleted = true;
    log(recall ? 'recall' : 'delete', (recall ? '撤回' : '删除') + '消息 ' + m.id, r.id);
    save();
  }

  function sendMediaFile(file, kind) {
    var r = findRoom(cur);
    var sp = g.ACL.canSpeak(me, r);
    if (!sp.ok) { g.UI.toast(sp.why, 'err'); return; }
    if (!g.ACL.can(me, 'media.send', r)) { g.UI.toast('没有发送媒体的权限', 'err'); return; }
    if (file.size > 60 * 1024 * 1024) { g.UI.toast('文件过大（上限 60MB）', 'err'); return; }
    g.UI.toast('处理中…');
    g.Media.readFile(file).then(function (dataUrl) {
      return (kind === 'image' ? g.Media.compressImage(dataUrl) : Promise.resolve(dataUrl)).then(function (u) {
        var id = uid('m');
        /* 唯一媒体路径：压缩后写入 IndexedDB，消息只记 mediaId */
        return g.Media.put(id, u).then(function () {
          var m = {
            id: uid('msg'), room: cur, from: me.id, type: kind,
            mediaId: id, name: file.name, size: g.Media.dataUrlSize(u), ts: now()
          };
          if (kind === 'video') {
            return g.Media.videoPoster(u).then(function (p) { if (p) m.poster = p; return m; })
              .catch(function () { return m; });
          }
          return m;
        });
      });
    }).then(function (m) { pushMsg(m); g.UI.toast('已发送', 'ok'); })
      .catch(function (e) { g.UI.toast('发送失败：' + (e && e.message ? e.message : '未知错误'), 'err'); });
  }

  /* ================= 命令 ================= */
  function command(line, r) {
    var parts = line.split(/\s+/);
    var cmd = parts[0].toLowerCase();
    var arg = parts.slice(1).join(' ');
    var rest = arg;

    switch (cmd) {
      case 'help': helpModal(); return;
      case 'me': sysMsg(cur, '*' + me.nick + ' ' + rest + '*'); save(); return;
      case 'nick':
        if (!rest.trim()) { g.UI.toast('用法：/nick 新昵称'); return; }
        me.nick = rest.trim(); touch(me);
        sysMsg(cur, '「' + me.nick + '」修改了昵称'); save(); return;
      case 'who':
        var names = membersOf(r).map(function (u) { return u.nick + '(' + (u.realName || '?') + ')'; }).join('、');
        sysMsg(cur, '本会话成员：' + names); save(); return;
      case 'dm':
      case 'msg': {
        if (!rest.trim()) { g.UI.toast('用法：/dm 昵称 内容'); return; }
        var nn = rest.split(/\s+/)[0];
        var t = rest.slice(nn.length).trim();
        var u = byNick(nn);
        if (!u) { g.UI.toast('找不到用户 ' + nn, 'err'); return; }
        openDM(u);
        if (t) {
          msgs(cur).push({ id: uid('msg'), room: cur, from: me.id, type: 'text', text: t, ts: now() });
          save();
        }
        return;
      }
      case 'create': {
        if (!g.ACL.can(me, 'room.create')) { g.UI.toast('没有建群权限', 'err'); return; }
        createRoom(rest.trim() || (me.nick + ' 的群'));
        return;
      }
      case 'join': {
        var nm = rest.trim();
        if (!nm) { g.UI.toast('用法：/join 群名'); return; }
        var rr = S.rooms.filter(function (x) { return x.type === 'group' && x.name.toLowerCase() === nm.toLowerCase(); })[0];
        if (!rr) { g.UI.toast('没有找到公开群「' + nm + '」', 'err'); return; }
        joinRoom(rr.id, me); save(); openRoom(rr.id); return;
      }
      case 'notice': {
        if (!g.ACL.can(me, 'room.notice', r)) { g.UI.toast('没有设置公告的权限', 'err'); return; }
        r.notice = rest; touch(r); log('notice', '修改公告', r.id); save(); return;
      }
      case 'mute': {
        var p = rest.split(/\s+/), u2 = byNick(p[0] || '');
        if (!u2) { g.UI.toast('用法：/mute @昵称 分钟'); return; }
        if (!g.ACL.can(me, 'user.mute', r)) { g.UI.toast('没有禁言权限', 'err'); return; }
        var min = parseInt(p[1] || '10', 10) || 10;
        if (g.ACL.roomRole(u2, r) === 'roomAdmin' && g.ACL.roomRole(me, r) !== 'roomOwner' && me.role !== 'owner') { g.UI.toast('不能禁言同级管理员', 'err'); return; }
        u2.mutedUntil = now() + min * 60000; touch(u2);
        sysMsg(cur, '「' + u2.nick + '」被禁言 ' + min + ' 分钟'); log('mute', u2.nick + ' ' + min + '分钟', r.id); save(); return;
      }
      case 'unmute': {
        var u3 = byNick(rest.split(/\s+/)[0] || '');
        if (!u3 || !g.ACL.can(me, 'user.mute', r)) { g.UI.toast('用法：/unmute @昵称'); return; }
        u3.mutedUntil = 0; touch(u3); sysMsg(cur, '「' + u3.nick + '」已被解除禁言'); log('unmute', u3.nick, r.id); save(); return;
      }
      case 'kick': {
        var u4 = byNick(rest.split(/\s+/)[0] || '');
        if (!u4 || !g.ACL.can(me, 'user.kick', r)) { g.UI.toast('用法：/kick @昵称（或权限不足）', 'err'); return; }
        if (r.type === 'public') { g.UI.toast('公屏大厅不能踢人', 'err'); return; }
        r.members = (r.members || []).filter(function (x) { return x !== u4.id; });
        touch(r); sysMsg(cur, '「' + u4.nick + '」已被移出群聊'); log('kick', u4.nick, r.id); save(); renderAll(); return;
      }
      case 'ban': {
        var u5 = byNick(rest.split(/\s+/)[0] || '');
        if (!u5 || !g.ACL.can(me, 'user.ban', r)) { g.UI.toast('用法：/ban @昵称（或权限不足）', 'err'); return; }
        u5.banned = true; touch(u5); sysMsg(cur, '「' + u5.nick + '」已被封禁'); log('ban', u5.nick); save(); return;
      }
      case 'unban': {
        var u6 = byNick(rest.split(/\s+/)[0] || '');
        if (!u6 || !g.ACL.can(me, 'user.ban', r)) { g.UI.toast('用法：/unban @昵称', 'err'); return; }
        u6.banned = false; touch(u6); sysMsg(cur, '「' + u6.nick + '」已被解封'); log('unban', u6.nick); save(); return;
      }
      case 'admin': {
        var u7 = byNick(rest.split(/\s+/)[0] || '');
        if (!u7 || !g.ACL.can(me, 'user.grant', r)) { g.UI.toast('用法：/admin @昵称（或权限不足）', 'err'); return; }
        if (r.admins.indexOf(u7.id) < 0) r.admins.push(u7.id);
        touch(r); sysMsg(cur, '「' + u7.nick + '」已成为本群管理员'); log('grant', u7.nick + ' 群管理', r.id); save(); return;
      }
      case 'unadmin': {
        var u8 = byNick(rest.split(/\s+/)[0] || '');
        if (!u8 || !g.ACL.can(me, 'user.grant', r)) { g.UI.toast('用法：/unadmin @昵称', 'err'); return; }
        r.admins = r.admins.filter(function (x) { return x !== u8.id; });
        touch(r); sysMsg(cur, '「' + u8.nick + '」已被撤销群管理员'); log('revoke', u8.nick, r.id); save(); return;
      }
      case 'invite': {
        var u9 = byNick(rest.split(/\s+/)[0] || '');
        if (!u9) { g.UI.toast('用法：/invite @昵称'); return; }
        if (!g.ACL.can(me, 'room.manage', r)) { g.UI.toast('没有邀请权限', 'err'); return; }
        joinRoom(r.id, u9); save(); return;
      }
      case 'transfer': {
        var ua = byNick(rest.split(/\s+/)[0] || '');
        if (!ua) { g.UI.toast('用法：/transfer @昵称'); return; }
        if (!g.ACL.can(me, 'user.transfer')) { g.UI.toast('只有站长可转让站长身份', 'err'); return; }
        g.UI.confirm('确定把站长转让给「' + ua.nick + '」？你将失去站长权限。', function () {
          me.role = 'admin'; touch(me);
          ua.role = 'owner'; touch(ua);
          sysMsg('public', '站长已转让给「' + ua.nick + '」');
          log('transfer', '站长 → ' + ua.nick); save(); renderAll();
        });
        return;
      }
      case 'clear': {
        if (!g.ACL.can(me, 'msg.delete', r)) { g.UI.toast('没有清空权限', 'err'); return; }
        g.UI.confirm('清空当前会话的全部消息？', function () {
          S.messages[r.id] = []; sysMsg(r.id, '消息已被管理员清空'); log('clear', '', r.id); save();
        });
        return;
      }
      case 'pwd': {
        if (!g.ACL.can(me, 'room.pwd', r)) { g.UI.toast('没有设置密码的权限', 'err'); return; }
        g.UI.prompt('群密码', '留空则取消密码', '', function (v) {
          if (!v) { r.pwd = null; sysMsg(r.id, '群密码已取消'); }
          else {
            var s = g.SHA256.randomId(12);
            r.pwd = { hash: hashPwd(v, s), salt: s };
            sysMsg(r.id, '群密码已更新');
          }
          touch(r); log('pwd', '', r.id); save();
        }, { password: true, required: false });
        return;
      }
      case 'sys': {
        if (me.role !== 'owner' && me.role !== 'admin') { g.UI.toast('仅管理员可用', 'err'); return; }
        S.rooms.forEach(function (x) { sysMsg(x.id, '【系统公告】' + rest); });
        log('sys', rest); save(); return;
      }
      case 'env': envModal(); return;
      default:
        g.UI.toast('未知命令 /' + cmd + '，输入 /help 查看帮助', 'err');
    }
  }

  function helpModal() {
    var rows = [
      ['/help', '显示本帮助'],
      ['/nick 新昵称', '修改昵称'],
      ['/dm 昵称 内容', '发起私聊并发送'],
      ['/create 群名', '自建群聊'],
      ['/join 群名', '加入公开群'],
      ['/notice 内容', '设置本群公告（管理员）'],
      ['/mute @昵称 分钟', '禁言（管理员）'],
      ['/unmute @昵称', '解除禁言'],
      ['/kick @昵称', '移出本群'],
      ['/ban @昵称', '封禁账号'],
      ['/unban @昵称', '解封账号'],
      ['/admin @昵称', '设为群管理员'],
      ['/unadmin @昵称', '撤销群管理员'],
      ['/invite @昵称', '邀请入群'],
      ['/transfer @昵称', '转让站长（仅站长）'],
      ['/clear', '清空本会话消息'],
      ['/pwd', '设置本群密码'],
      ['/sys 内容', '全站系统公告'],
      ['/env', '运行环境自检']
    ];
    var d = elc('div', '');
    d.innerHTML = '<div class="cmd-list">' + rows.map(function (x) {
      return '<div class="cmd-row"><code>' + g.UI.esc(x[0]) + '</code><span>' + g.UI.esc(x[1]) + '</span></div>';
    }).join('') + '</div>' +
      '<div class="form-note">Markdown：**粗体**、*斜体*、~~删除线~~、`代码`、```代码块```、> 引用、- 列表、| 表格 |、[链接](url)、![图片](url)<br>' +
      'LaTeX（仿洛谷，用 $ 包裹）：$x^2+y^2=z^2$、$$\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$$、$$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$$</div>';
    g.UI.modal({ title: '命令与语法帮助', body: d, okText: '知道了', cancelText: null, wide: true });
  }

  function envModal() {
    var e = g.Net.env();
    var d = elc('div', 'env-grid');
    var kv = [
      ['部署形态', e.deploy],
      ['运行架构', '统一架构：浏览器内状态 + 广播同步（本地与 Pages 完全一致）'],
      ['状态存储', e.storage ? 'localStorage（快照）' : 'localStorage 不可用'],
      ['媒体存储', e.indexedDB ? 'IndexedDB（唯一路径）' : 'IndexedDB 不可用'],
      ['多标签同步', e.broadcast ? (e.syncActive ? 'BroadcastChannel 已连接' : '支持但未连接') : '不支持（单标签会话）'],
      ['C++/WASM 加速', e.accel ? '已启用' : '未启用（可选，失败自动回退 JS）'],
      ['WebAssembly', e.wasm ? '支持' : '不支持'],
      ['Web Crypto', e.crypto ? '支持' : '不支持'],
      ['安全上下文', e.secure ? '是' : '否（file:// 下部分能力受限）'],
      ['网络', e.online ? '在线' : '离线（不影响使用）'],
      ['屏幕 / DPR', e.screen + ' @' + e.dpr + 'x'],
      ['用户数 / 房间数', S.users.length + ' / ' + S.rooms.length],
      ['消息总数', Object.keys(S.messages).reduce(function (a, k) { return a + S.messages[k].length; }, 0)],
      ['状态快照体积', (function () {
        try { return (Math.round((localStorage.getItem(KEY) || '').length / 1024)) + ' KB（不含媒体）'; }
        catch (er) { return '未知'; }
      })()]
    ];
    d.innerHTML = kv.map(function (x) {
      return '<div class="env-item"><div class="env-k">' + g.UI.esc(x[0]) + '</div><div class="env-v">' + g.UI.esc(x[1]) + '</div></div>';
    }).join('');
    g.UI.modal({ title: '运行环境自检', body: d, okText: '关闭', cancelText: null, wide: true });
  }

  /* ================= 房间操作 ================= */
  function openRoom(rid) {
    var r = findRoom(rid);
    if (!r) return;
    if (r.pwd && r.members && r.members.indexOf(me.id) < 0) {
      g.UI.prompt('需要群密码', '请输入「' + r.name + '」的进入密码', '', function (v) {
        if (hashPwd(v, r.pwd.salt) !== r.pwd.hash) { g.UI.toast('密码错误', 'err'); return; }
        joinRoom(rid, me); save(); cur = rid; unread[rid] = 0; renderAll(); scrollBottom();
      }, { password: true });
      return;
    }
    cur = rid; unread[rid] = 0;
    renderAll(); scrollBottom();
    $('input').focus();
  }

  function openDM(u) {
    if (!u) return;
    var id = 'dm:' + [me.id, u.id].sort().join('-');
    var r = findRoom(id);
    if (!r) {
      r = {
        id: id, name: '私聊', type: 'private', desc: '', owner: null, admins: [],
        members: [me.id, u.id], pwd: null, notice: '', muted: [], createdAt: now(), updatedAt: now()
      };
      S.rooms.push(r);
      save(true);
    }
    openRoom(id);
  }

  function createRoom(name) {
    var d = elc('div', '');
    d.innerHTML =
      '<label class="field-label">群名称</label><input class="field" id="cName" value="' + g.UI.esc(name) + '">' +
      '<label class="field-label">群简介</label><input class="field" id="cDesc" placeholder="选填">' +
      '<label class="field-label">进入密码（选填）</label><input class="field" id="cPwd" type="password" placeholder="留空则任何人可直接加入">' +
      '<label class="field-label">初始成员（昵称，逗号分隔，选填）</label><input class="field" id="cMem" placeholder="例如：小明,小红">' +
      '<div class="field-hint">创建者自动成为群主，可设置管理员、公告、密码、踢人与禁言。</div>';
    g.UI.modal({
      title: '创建群聊', body: d, okText: '创建', onOk: function (body) {
        var nm = body.querySelector('#cName').value.trim();
        if (!nm) { g.UI.toast('群名不能为空'); return false; }
        var pwd = body.querySelector('#cPwd').value;
        var r = {
          id: uid('r'), name: nm, type: 'group', desc: body.querySelector('#cDesc').value.trim(),
          owner: me.id, admins: [], members: [me.id], pwd: null,
          notice: '', muted: [], createdAt: now(), updatedAt: now()
        };
        if (pwd) { var s = g.SHA256.randomId(12); r.pwd = { hash: hashPwd(pwd, s), salt: s }; }
        body.querySelector('#cMem').value.split(/[,，\s]+/).forEach(function (n) {
          if (!n) return;
          var u = byNick(n);
          if (u && r.members.indexOf(u.id) < 0) r.members.push(u.id);
        });
        S.rooms.push(r);
        sysMsg(r.id, '「' + me.nick + '」创建了群聊');
        log('create', nm, r.id);
        save(true);
        openRoom(r.id);
      }
    });
  }

  function roomMenu(r) {
    var d = elc('div', '');
    var items = [];
    items.push(['打开', function () { openRoom(r.id); }]);
    if (r.type !== 'public') {
      items.push(['邀请成员', function () {
        g.UI.prompt('邀请成员', '输入昵称', '', function (n) {
          var u = byNick(n); if (!u) { g.UI.toast('找不到用户'); return; }
          joinRoom(r.id, u); save();
        });
      }]);
    }
    if (g.ACL.can(me, 'room.manage', r)) items.push(['群设置', function () { roomSettings(r); }]);
    if (g.ACL.can(me, 'room.notice', r)) items.push(['编辑公告', function () { editNotice(r); }]);
    if (g.ACL.can(me, 'room.pwd', r)) items.push(['群密码', function () { editPwd(r); }]);
    if (g.ACL.can(me, 'room.delete', r)) items.push(['解散/删除', function () {
      g.UI.confirm('确定删除「' + roomTitleOf(r) + '」？', function () {
        S.rooms = S.rooms.filter(function (x) { return x.id !== r.id; });
        delete S.messages[r.id]; if (cur === r.id) cur = 'public';
        log('delroom', r.name, r.id); save(); renderAll();
      });
    }]);
    if (r.type !== 'public' && r.members && r.members.indexOf(me.id) >= 0 && r.owner !== me.id) {
      items.push(['退出群聊', function () {
        r.members = r.members.filter(function (x) { return x !== me.id; });
        touch(r); sysMsg(r.id, '「' + me.nick + '」退出了群聊'); save(); renderAll();
      }]);
    }
    d.innerHTML = '<div class="cmd-list">' + items.map(function (x, i) {
      return '<div class="cmd-row clickable" data-i="' + i + '"><span>' + g.UI.esc(x[0]) + '</span></div>';
    }).join('') + '</div>';
    var mo = g.UI.modal({ title: roomTitleOf(r), body: d, okText: null, cancelText: '关闭' });
    Array.prototype.forEach.call(d.querySelectorAll('.cmd-row'), function (row) {
      row.onclick = function () { mo.close(); items[+row.dataset.i][1](); };
    });
  }

  function editNotice(r) {
    g.UI.prompt('群公告', '支持 Markdown 与 $公式$', r.notice || '', function (v) {
      r.notice = v; touch(r); log('notice', '', r.id); save();
    }, { required: false });
  }
  function editPwd(r) {
    g.UI.prompt('群密码', '留空取消密码', '', function (v) {
      if (!v) r.pwd = null;
      else { var s = g.SHA256.randomId(12); r.pwd = { hash: hashPwd(v, s), salt: s }; }
      touch(r); log('pwd', '', r.id); save();
    }, { password: true, required: false });
  }

  function roomSettings(r) {
    var d = elc('div', '');
    d.innerHTML =
      '<label class="field-label">群名称</label><input class="field" id="sName" value="' + g.UI.esc(r.name) + '">' +
      '<label class="field-label">群简介</label><input class="field" id="sDesc" value="' + g.UI.esc(r.desc || '') + '">' +
      '<div class="sec-title">群管理员</div><div id="sAdmin" class="chip-box"></div>' +
      '<div class="sec-title">成员管理</div><div id="sMem" class="chip-box"></div>' +
      '<div class="sec-title">转让群主</div><div id="sOwner" class="chip-box"></div>';
    var mo = g.UI.modal({
      title: '群设置', body: d, wide: true, okText: '保存', onOk: function (body) {
        r.name = body.querySelector('#sName').value.trim() || r.name;
        r.desc = body.querySelector('#sDesc').value.trim();
        touch(r); log('roomset', r.name, r.id); save();
      }
    });
    var ab = d.querySelector('#sAdmin');
    membersOf(r).forEach(function (u) {
      var b = elc('button', 'chip' + (r.admins.indexOf(u.id) >= 0 ? ' on' : ''), u.nick + (r.admins.indexOf(u.id) >= 0 ? ' ✓' : ''));
      b.onclick = function () {
        if (!g.ACL.can(me, 'user.grant', r)) { g.UI.toast('无授权权限', 'err'); return; }
        var i = r.admins.indexOf(u.id);
        if (i >= 0) r.admins.splice(i, 1); else r.admins.push(u.id);
        touch(r); save(true); mo.close(); roomSettings(r);
      };
      ab.appendChild(b);
    });
    var mb = d.querySelector('#sMem');
    membersOf(r).forEach(function (u) {
      var b = elc('button', 'chip', u.nick);
      b.title = '点击管理该成员';
      b.onclick = function () { mo.close(); userCard(u, r); };
      mb.appendChild(b);
    });
    var ob = d.querySelector('#sOwner');
    var tb = elc('button', 'chip', '转让给…');
    tb.onclick = function () {
      if (r.owner !== me.id && me.role !== 'owner') { g.UI.toast('只有群主或站长可转让'); return; }
      g.UI.prompt('转让群主', '输入新群主昵称', '', function (n) {
        var u = byNick(n); if (!u) { g.UI.toast('找不到用户'); return; }
        r.owner = u.id; if (r.admins.indexOf(u.id) < 0) r.admins.push(u.id);
        touch(r); sysMsg(r.id, '群主已转让给「' + u.nick + '」'); log('roomtransfer', u.nick, r.id); save();
      });
    };
    ob.appendChild(tb);
  }

  /* ================= 用户卡 / 资料 ================= */
  function userCard(u, r) {
    var d = elc('div', '');
    var rr = g.ACL.roomRole(u, r);
    d.innerHTML =
      '<div class="uc-head"><div id="ucAv"></div><div>' +
      '<div class="uc-nick">' + g.UI.esc(u.nick) + '</div>' +
      '<div class="uc-real">实名：' + g.UI.esc(u.realName || '未填写') + '</div>' +
      '<div class="uc-role">' + g.ACL.roleName(u) + ' · 本群：' + rr + '</div></div></div>' +
      '<div class="uc-bio">' + g.UI.esc(u.bio || '这个人很懒，什么都没写。') + '</div>' +
      '<div class="uc-meta">注册：' + g.UI.fmtFull(u.createdAt) + ' · 最后活跃：' + g.UI.fmtFull(u.lastSeen || u.createdAt) + '</div>' +
      '<div class="uc-state">' + (u.banned ? '<span class="tag red">已封禁</span> ' : '') +
      (g.ACL.muted(u) ? '<span class="tag orange">禁言中（剩 ' + g.ACL.muteLeft(u) + ' 秒）</span>' : '') + '</div>' +
      '<div id="ucActs" class="uc-acts"></div>';
    var mo = g.UI.modal({ title: '用户资料', body: d, okText: null, cancelText: '关闭' });
    d.querySelector('#ucAv').appendChild(g.UI.avatar(u, 'lg'));
    var acts = d.querySelector('#ucActs');

    function btn(txt, cls, fn) {
      var b = elc('button', 'btn ' + (cls || 'ghost'), txt);
      b.onclick = function () { mo.close(); fn(); };
      acts.appendChild(b);
    }
    btn('私聊', 'primary', function () { openDM(u); });
    btn('@TA', '', function () {
      var ta = $('input'); ta.value += '@' + u.nick + ' '; ta.focus();
    });
    if (g.ACL.can(me, 'user.mute', r)) {
      btn(g.ACL.muted(u) ? '解除禁言' : '禁言', '', function () {
        if (g.ACL.muted(u)) { u.mutedUntil = 0; touch(u); save(); }
        else {
          g.UI.prompt('禁言时长', '分钟', '10', function (v) {
            var m = parseInt(v, 10) || 10;
            u.mutedUntil = now() + m * 60000; touch(u);
            sysMsg(r.id, '「' + u.nick + '」被禁言 ' + m + ' 分钟'); log('mute', u.nick, r.id); save();
          });
        }
      });
    }
    if (g.ACL.can(me, 'user.kick', r) && r.type !== 'public') {
      btn('移出本群', '', function () {
        r.members = (r.members || []).filter(function (x) { return x !== u.id; });
        touch(r); sysMsg(r.id, '「' + u.nick + '」已被移出群聊'); log('kick', u.nick, r.id); save(); renderAll();
      });
    }
    if (g.ACL.can(me, 'user.ban', r)) {
      btn(u.banned ? '解封账号' : '封禁账号', 'danger', function () {
        u.banned = !u.banned; touch(u);
        sysMsg(r.id, '「' + u.nick + '」' + (u.banned ? '已被封禁' : '已被解封'));
        log(u.banned ? 'ban' : 'unban', u.nick); save();
      });
    }
    if (g.ACL.can(me, 'user.grant', r)) {
      btn(u.role === 'admin' ? '撤销管理员' : '设为管理员', '', function () {
        if (u.role === 'admin') { u.role = 'member'; log('revoke-admin', u.nick); }
        else { u.role = 'admin'; log('grant-admin', u.nick); }
        touch(u); sysMsg(r.id, '「' + u.nick + '」' + (u.role === 'admin' ? '已成为管理员' : '已被撤销管理员'));
        save();
      });
    }
    if (me.role === 'owner' && u.id !== me.id) {
      btn('转让站长', 'danger', function () {
        g.UI.confirm('把站长转让给「' + u.nick + '」？你将变为管理员。', function () {
          me.role = 'admin'; touch(me); u.role = 'owner'; touch(u);
          sysMsg('public', '站长已转让给「' + u.nick + '」'); log('transfer', u.nick); save(); renderAll();
        });
      });
    }
    if (me.role === 'owner' && u.id !== me.id) {
      btn('权限微调', '', function () { permEditor(u); });
    }
  }

  function permEditor(u) {
    var d = elc('div', '');
    d.innerHTML = '<div class="form-tip">为「' + g.UI.esc(u.nick) + '」单独授予/收回权限（不影响其角色基础权限）。</div><div class="perm-grid"></div>';
    var grid = d.querySelector('.perm-grid');
    g.ACL.all().forEach(function (p) {
      var lab = elc('label', 'perm-item');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = (u.perms || []).indexOf(p) >= 0;
      cb.dataset.p = p;
      lab.appendChild(cb);
      lab.appendChild(elc('span', '', g.ACL.label(p) + '（' + p + '）'));
      grid.appendChild(lab);
    });
    g.UI.modal({
      title: '权限微调', body: d, wide: true, okText: '保存', onOk: function (body) {
        var sel = [];
        Array.prototype.forEach.call(body.querySelectorAll('input[type=checkbox]'), function (c) {
          if (c.checked) sel.push(c.dataset.p);
        });
        u.perms = sel; touch(u); log('perm', u.nick + ': ' + sel.join(',')); save();
      }
    });
  }

  function openProfile() {
    var d = elc('div', '');
    d.innerHTML =
      '<label class="field-label">昵称</label><input class="field" id="pNick" value="' + g.UI.esc(me.nick) + '">' +
      '<label class="field-label">真实姓名</label><input class="field" id="pReal" value="' + g.UI.esc(me.realName || '') + '">' +
      '<label class="field-label">个性签名</label><input class="field" id="pBio" value="' + g.UI.esc(me.bio || '') + '">' +
      '<label class="field-label">修改登录密码（留空不改）</label><input class="field" id="pPwd" type="password">' +
      '<div class="field-hint">头像由昵称首字母自动生成，配色取自昵称哈希。</div>';
    g.UI.modal({
      title: '我的资料', body: d, okText: '保存', onOk: function (body) {
        var n = body.querySelector('#pNick').value.trim();
        if (!n) { g.UI.toast('昵称不能为空'); return false; }
        var dup = byNick(n);
        if (dup && dup.id !== me.id) { g.UI.toast('昵称已被占用'); return false; }
        me.nick = n;
        me.realName = body.querySelector('#pReal').value.trim();
        me.bio = body.querySelector('#pBio').value.trim();
        var p = body.querySelector('#pPwd').value;
        if (p) {
          if (p.length < 4) { g.UI.toast('密码至少 4 位'); return false; }
          var s = g.SHA256.randomId(12);
          me.pwdSalt = s; me.pwdHash = hashPwd(p, s);
        }
        touch(me); log('profile', me.nick); save();
      }
    });
  }

  /* ================= 管理面板 ================= */
  function adminPanel() {
    if (!g.ACL.can(me, 'log.view')) { g.UI.toast('仅管理员可打开管理面板', 'err'); return; }
    var d = elc('div', '');
    d.innerHTML =
      '<div class="tabs">' +
      '<button class="tab on" data-t="users">用户</button>' +
      '<button class="tab" data-t="rooms">房间</button>' +
      '<button class="tab" data-t="perms">权限</button>' +
      '<button class="tab" data-t="logs">日志</button>' +
      '<button class="tab" data-t="site">站点</button>' +
      '</div><div id="apBody" class="ap-body"></div>';
    var mo = g.UI.modal({ title: '管理面板', body: d, wide: true, okText: null, cancelText: '关闭' });

    function view(t) {
      Array.prototype.forEach.call(d.querySelectorAll('.tab'), function (b) { b.classList.toggle('on', b.dataset.t === t); });
      var b = d.querySelector('#apBody');
      b.innerHTML = '';
      if (t === 'users') {
        S.users.slice().sort(function (x, y) { return (y.lastSeen || 0) - (x.lastSeen || 0); }).forEach(function (u) {
          var line = elc('div', 'user-line');
          line.appendChild(g.UI.avatar(u, 'sm'));
          var main = elc('div', 'user-line-main');
          main.innerHTML = '<div class="user-line-name">' + g.UI.esc(u.nick) + ' <span class="user-real">' + g.UI.esc(u.realName || '') + '</span></div>' +
            '<div class="user-line-role">' + g.ACL.roleName(u) + ' · ' + g.UI.fmtTime(u.lastSeen || u.createdAt) + '</div>';
          line.appendChild(main);
          if (u.banned) line.appendChild(elc('span', 'tag red', '封禁'));
          if (g.ACL.muted(u)) line.appendChild(elc('span', 'tag orange', '禁言'));
          var ops = elc('div', 'line-ops');
          ops.appendChild(mkBtn('资料', function () { mo.close(); userCard(u, findRoom(cur)); }));
          if (g.ACL.can(me, 'user.ban')) ops.appendChild(mkBtn(u.banned ? '解封' : '封禁', function () { u.banned = !u.banned; touch(u); log(u.banned ? 'ban' : 'unban', u.nick); save(); adminPanelRefresh(mo, d, view, t); }));
          if (g.ACL.can(me, 'user.mute')) ops.appendChild(mkBtn(g.ACL.muted(u) ? '解禁' : '禁言', function () {
            if (g.ACL.muted(u)) { u.mutedUntil = 0; touch(u); save(); }
            else g.UI.prompt('禁言分钟数', '', '10', function (v) { u.mutedUntil = now() + (parseInt(v, 10) || 10) * 60000; touch(u); log('mute', u.nick); save(); });
            adminPanelRefresh(mo, d, view, t);
          }));
          if (me.role === 'owner') ops.appendChild(mkBtn(u.role === 'admin' ? '撤管理' : '设管理', function () { u.role = u.role === 'admin' ? 'member' : 'admin'; touch(u); log('role', u.nick + '→' + u.role); save(); adminPanelRefresh(mo, d, view, t); }));
          if (me.role === 'owner') ops.appendChild(mkBtn('权限', function () { mo.close(); permEditor(u); }));
          if (me.role === 'owner') ops.appendChild(mkBtn('删除', function () {
            g.UI.confirm('删除用户「' + u.nick + '」？其消息将保留。', function () {
              S.users = S.users.filter(function (x) { return x.id !== u.id; });
              log('deluser', u.nick); save(); adminPanelRefresh(mo, d, view, t);
            });
          }));
          line.appendChild(ops);
          b.appendChild(line);
        });
      } else if (t === 'rooms') {
        S.rooms.forEach(function (r) {
          var line = elc('div', 'user-line');
          line.appendChild(elc('div', 'avatar', (r.name || '群').slice(0, 1)));
          var main = elc('div', 'user-line-main');
          main.innerHTML = '<div class="user-line-name">' + g.UI.esc(r.name) + ' <span class="user-real">' +
            (r.type === 'public' ? '公屏' : r.type === 'private' ? '私聊' : '群聊 ' + ((r.members || []).length) + ' 人') + '</span></div>' +
            '<div class="user-line-role">' + g.UI.fmtTime(r.createdAt) + (r.pwd ? ' · 有密码' : '') + '</div>';
          line.appendChild(main);
          var ops = elc('div', 'line-ops');
          ops.appendChild(mkBtn('打开', function () { mo.close(); openRoom(r.id); }));
          if (g.ACL.can(me, 'room.manage', r)) ops.appendChild(mkBtn('设置', function () { mo.close(); roomSettings(r); }));
          if (g.ACL.can(me, 'room.notice', r)) ops.appendChild(mkBtn('公告', function () { mo.close(); editNotice(r); }));
          if (g.ACL.can(me, 'room.delete', r)) ops.appendChild(mkBtn('删除', function () {
            g.UI.confirm('删除「' + r.name + '」？', function () {
              S.rooms = S.rooms.filter(function (x) { return x.id !== r.id; });
              delete S.messages[r.id]; log('delroom', r.name, r.id); save(); adminPanelRefresh(mo, d, view, t);
            });
          }));
          line.appendChild(ops);
          b.appendChild(line);
        });
      } else if (t === 'perms') {
        var tip = elc('div', 'form-tip');
        tip.textContent = '角色基础权限（owner 拥有全部；admin 为全局管理；member 为普通成员）。站长可对任意用户做单独微调（用户资料 → 权限微调）。';
        b.appendChild(tip);
        var wrap = elc('div', 'perm-table-wrap');
        var html = '<table class="md-table"><thead><tr><th>权限</th><th>owner</th><th>admin</th><th>member</th></tr></thead><tbody>';
        g.ACL.all().forEach(function (p) {
          html += '<tr><td>' + g.UI.esc(g.ACL.label(p)) + ' <code>' + p + '</code></td>' +
            '<td>' + (g.ACL.ROLE_PERMS.owner.indexOf(p) >= 0 ? '✓' : '—') + '</td>' +
            '<td>' + (g.ACL.ROLE_PERMS.admin.indexOf(p) >= 0 ? '✓' : '—') + '</td>' +
            '<td>' + (g.ACL.ROLE_PERMS.member.indexOf(p) >= 0 ? '✓' : '—') + '</td></tr>';
        });
        html += '</tbody></table>';
        wrap.innerHTML = html;
        b.appendChild(wrap);
        var extras = elc('div', 'sec-title', '特殊授权用户');
        b.appendChild(extras);
        S.users.filter(function (u) { return (u.perms || []).length; }).forEach(function (u) {
          var line = elc('div', 'user-line');
          line.appendChild(g.UI.avatar(u, 'sm'));
          var main = elc('div', 'user-line-main');
          main.innerHTML = '<div class="user-line-name">' + g.UI.esc(u.nick) + '</div>' +
            '<div class="user-line-role">' + g.UI.esc((u.perms || []).map(g.ACL.label).join('、')) + '</div>';
          line.appendChild(main);
          if (me.role === 'owner') line.appendChild(mkBtn('编辑', function () { mo.close(); permEditor(u); }));
          b.appendChild(line);
        });
      } else if (t === 'logs') {
        var l = elc('div', 'log-list');
        if (!S.logs.length) l.appendChild(elc('div', 'empty-tip', '暂无日志'));
        S.logs.slice(0, 120).forEach(function (x) {
          var who = findUser(x.who);
          var row = elc('div', 'log-row');
          row.innerHTML = '<span class="log-t">' + g.UI.fmtFull(x.ts) + '</span>' +
            '<span class="log-w">' + g.UI.esc(who ? who.nick : '系统') + '</span>' +
            '<span class="log-a">' + g.UI.esc(x.act) + '</span>' +
            '<span class="log-d">' + g.UI.esc(x.detail || '') + '</span>';
          l.appendChild(row);
        });
        b.appendChild(l);
      } else {
        var sd = elc('div', '');
        sd.innerHTML =
          '<label class="field-label">站点名称</label><input class="field" id="stName" value="' + g.UI.esc(S.siteName || '') + '">' +
          '<label class="field-label">保护密码（留空不改）</label><input class="field" id="stGate" type="password" placeholder="进入本聊天室所需密码">' +
          '<label class="field-label">开放注册</label><select class="field" id="stReg">' +
          '<option value="1"' + (S.allowRegister ? ' selected' : '') + '>允许任何人注册</option>' +
          '<option value="0"' + (!S.allowRegister ? ' selected' : '') + '>关闭公开注册</option></select>' +
          '<div class="field-hint">数据全部保存在本机浏览器（localStorage + IndexedDB），不上传任何服务器。' +
          '需要换设备或备份时，用下面的「导出 / 导入 JSON」搬运，本地版与上线版操作完全相同。</div>' +
          '<div class="sec-title">数据</div>' +
          '<button class="btn ghost" id="stExport">导出 JSON</button> ' +
          '<button class="btn ghost" id="stImport">导入 JSON</button> ' +
          '<button class="btn ghost" id="stEnv">运行环境</button> ' +
          '<button class="btn danger" id="stReset">重置站点</button>' +
          '<input type="file" id="stFile" accept="application/json" class="hidden">';
        b.appendChild(sd);
        sd.querySelector('#stExport').onclick = function () {
          var blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'chat-state-' + new Date().toISOString().slice(0, 10) + '.json';
          a.click();
        };
        sd.querySelector('#stFile').onchange = function (e) {
          var f = e.target.files[0]; if (!f) return;
          var fr = new FileReader();
          fr.onload = function () {
            try {
              var o = JSON.parse(fr.result);
              if (mergeState(o)) { save(); g.UI.toast('已导入并合并', 'ok'); mo.close(); }
              else g.UI.toast('文件格式不正确', 'err');
            } catch (er) { g.UI.toast('解析失败', 'err'); }
          };
          fr.readAsText(f);
        };
        sd.querySelector('#stImport').onclick = function () { sd.querySelector('#stFile').click(); };
        sd.querySelector('#stEnv').onclick = function () { envModal(); };
        sd.querySelector('#stReset').onclick = function () {
          g.UI.confirm('将清空全部用户、房间与消息（媒体仍在 IndexedDB）。确定？', function () {
            S = fresh(); ensurePublic();
            var s = g.SHA256.randomId(12);
            me = {
              id: uid('u'), nick: '站长', realName: '站长', pwdHash: hashPwd('admin', s), pwdSalt: s,
              role: 'owner', perms: [], banned: false, mutedUntil: 0, bio: '', createdAt: now(), updatedAt: now(), lastSeen: now()
            };
            S.users.push(me);
            sessionStorage.setItem(ME_KEY, me.id);
            save(); mo.close(); g.UI.toast('已重置，站长密码为 admin，请立即修改', 'ok');
            renderAll();
          });
        };
        var saveBtn = elc('button', 'btn primary block', '保存站点设置');
        saveBtn.onclick = function () {
          S.siteName = sd.querySelector('#stName').value.trim() || S.siteName;
          var gp = sd.querySelector('#stGate').value;
          if (gp) {
            if (gp.length < 4) { g.UI.toast('保护密码至少 4 位'); return; }
            var s2 = g.SHA256.randomId(12);
            S.gate = { hash: hashPwd(gp, s2), salt: s2 };
            log('gate', '修改保护密码');
          }
          S.allowRegister = sd.querySelector('#stReg').value === '1';
          save(); g.UI.toast('已保存', 'ok');
        };
        b.appendChild(saveBtn);
      }
    }
    Array.prototype.forEach.call(d.querySelectorAll('.tab'), function (btn) {
      btn.onclick = function () { view(btn.dataset.t); };
    });
    view('users');
    return mo;
  }
  function adminPanelRefresh(mo, d, view, t) { mo.close(); adminPanel(); }
  function mkBtn(txt, fn) {
    var b = elc('button', 'mini-btn', txt);
    b.onclick = function (e) { e.stopPropagation(); fn(); };
    return b;
  }

  /* ================= 事件绑定 ================= */
  function bindEvents() {
    $('btnSend').onclick = send;
    var ta = $('input');
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    ta.addEventListener('input', function () {
      ta.style.height = 'auto';
      ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
    });
    $('btnImg').onclick = function () { $('fileImg').click(); };
    $('fileImg').onchange = function (e) {
      var f = e.target.files[0]; if (f) sendMediaFile(f, 'image');
      e.target.value = '';
    };
    $('btnVideo').onclick = function () { $('fileVideo').click(); };
    $('fileVideo').onchange = function (e) {
      var f = e.target.files[0]; if (f) sendMediaFile(f, 'video');
      e.target.value = '';
    };
    $('btnEmoji').onclick = toggleEmoji;
    $('btnHelp').onclick = helpModal;
    $('btnNewRoom').onclick = function () { createRoom(''); };
    $('btnAdmin').onclick = adminPanel;
    $('btnLogout').onclick = function () {
      g.UI.confirm('退出登录？', function () {
        sessionStorage.removeItem(ME_KEY);
        me = null; cur = 'public';
        $('app').classList.add('hidden');
        loginView();
      });
    };
    $('btnMembers').onclick = function () {
      var p = $('sidePanel');
      p.classList.toggle('hidden');
    };
    $('btnRoomSet').onclick = function () { roomMenu(findRoom(cur)); };
    $('btnEditNotice').onclick = function () { editNotice(findRoom(cur)); };
    $('searchInput').addEventListener('input', function (e) { roomFilter = e.target.value; renderSidebar(); });
    $('btnMenu').onclick = function () { $('sidebar').classList.toggle('show'); };
    $('noticeBar').onclick = function () {
      var r = findRoom(cur);
      if (r) editNotice(r);
    };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { g.UI.closeLightbox(); }
    });
    /* 拖拽发送 */
    var box = $('msgScroll');
    box.addEventListener('dragover', function (e) { e.preventDefault(); });
    box.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer.files[0];
      if (!f) return;
      sendMediaFile(f, /^video\//.test(f.type) ? 'video' : 'image');
    });
  }

  function toggleEmoji() {
    var old = document.querySelector('.emoji-panel');
    if (old) { old.remove(); return; }
    var p = elc('div', 'emoji-panel');
    ['😀', '😄', '😁', '😂', '🤣', '😊', '😍', '😘', '😉', '😎', '🤔', '😴',
      '😭', '😡', '🥳', '😱', '🤯', '🫡', '👍', '👏', '🙏', '💪', '🎉', '❤️',
      '🔥', '✨', '🌙', '☀️', '🍀', '🐟', '🚀', '💡', '📚', '💻', '🎵', '⭐'].forEach(function (s) {
        var b = elc('button', 'emoji', s);
        b.onclick = function () { $('input').value += s; p.remove(); $('input').focus(); };
        p.appendChild(b);
      });
    var wrap = $('input').parentNode;
    wrap.appendChild(p);
    setTimeout(function () {
      document.addEventListener('click', function h() {
        p.remove(); document.removeEventListener('click', h);
      });
    }, 10);
  }

  /* ================= 启动 ================= */
  function boot() {
    S = load();
    if (!S) { S = fresh(); ensurePublic(); save(true); }
    initSync();
    if (!S.gate) { setupGate(); return; }
    if (sessionStorage.getItem(GATE_KEY) !== '1') { enterGate(); return; }
    afterGate();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  g.APP = {
    state: function () { return S; },
    me: function () { return me; },
    openRoom: openRoom,
    debugReset: function () { localStorage.removeItem(KEY); location.reload(); }
  };
})(window);
