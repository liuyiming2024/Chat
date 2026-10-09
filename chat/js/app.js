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
  var drafts = {};        /* 草稿：房间 id -> 输入内容 */
  var typingAt = 0;       /* 正在输入：上次按键时间 */

  /* ================= 小工具 ================= */
  function $(id) { return document.getElementById(id); }
  function setPlayIcon(btn) {
    if (btn) btn.innerHTML = '<svg class="ic ic-fill" aria-hidden="true"><use href="#i-play"/></svg>';
  }

  /* 图标：从 index.html 内联的雪碧图取。
     换掉 emoji 后必须保留 title / aria-label —— 图标比 emoji 抽象，
     没有文字提示，28px 的按钮照样得靠猜。 */
  function ic(name, cls) {
    return '<svg class="ic ' + (cls || '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

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

  /* ------------------------------------------------------------------
   * 口令校验（含历史哈希迁移）
   *   历史版本的 SHA-256 常数有误，产出的哈希不是标准值。
   *   这里先按标准算法比对；不中则回退遗留算法。
   *   遗留算法命中时返回 legacy:true，调用处会用标准算法静默重写，
   *   用户无感知，旧哈希随登录逐条升级。
   * ------------------------------------------------------------------ */
  function verifyPwd(p, salt, hash) {
    if (hashPwd(p, salt) === hash) return { ok: true, legacy: false };
    if (g.SHA256.slowHashLegacy && g.SHA256.slowHashLegacy(p, salt, 4000) === hash) {
      return { ok: true, legacy: true };
    }
    return { ok: false, legacy: false };
  }

  function log(act, detail, target) {
    S.logs.unshift({ id: uid('l'), ts: now(), who: me ? me.id : 'system', act: act, detail: detail || '', target: target || '' });
    if (S.logs.length > 400) S.logs.length = 400;
  }

  /* ================= 状态存取 ================= */
  function fresh() {
    return {
      version: 1, createdAt: now(), seq: 0, siteName: '聊天室',
      gate: null, allowRegister: true, needReview: true,
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
    card.innerHTML = '<div class="gate-title">聊天室</div>' +
      '<div class="gate-sub">支持 Markdown 与 $LaTeX$ · 纯前端运行</div>';
    var box = elc('div', '');
    box.innerHTML = inner;
    card.appendChild(box);
    wrap.appendChild(card);
    /* 同时用内联样式控制显示：即使 CSS 未加载也不会出现门禁与主界面重叠 */
    wrap.classList.remove('hidden');
    wrap.style.display = 'flex';
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
      '<label class="field-label">站长昵称</label><input class="field" id="gNick" placeholder="例如：站长">' +
      '<label class="field-label">站长登录密码</label><input class="field" id="gPwd" type="password">' +
      '<button class="btn primary block" id="gOk">创建并进入</button>' +
      '<div class="form-note">保护密码与登录密码均经加盐慢哈希存储，不保存明文。</div>' +
      '<div class="form-note demo-note">提示：正在使用云端后端——账号与消息存在服务器，换设备也能看到。' +
      '（若此处提示连接失败，会自动退回单机模式，数据只存本机。）</div>'
    );
    card.querySelector('#gOk').onclick = function () {
      var gp = card.querySelector('#gGate').value, gp2 = card.querySelector('#gGate2').value;
      var nick = card.querySelector('#gNick').value.trim();
      var pwd = card.querySelector('#gPwd').value;
      if (gp.length < 4) { g.UI.toast('保护密码至少 4 位'); return; }
      if (gp !== gp2) { g.UI.toast('两次保护密码不一致'); return; }
      if (!nick) { g.UI.toast('请填写站长昵称'); return; }
      if (pwd.length < 4) { g.UI.toast('登录密码至少 4 位'); return; }
      /* 在线模式：交给服务端建站（保护密码与站长密码都在服务端 bcrypt） */
      if (g.Online && g.Online.isReachable()) {
        g.Online.setup(gp, nick, pwd).then(function (r) {
          sessionStorage.setItem(GATE_KEY, '1');
          if (r && r.uid) sessionStorage.setItem(ME_KEY, r.uid);
          return g.Online.pull().then(function (inS) {
            if (inS && mergeState(inS)) save(true);
            g.Online.startPoll();
            afterGate();
          });
        }).catch(function (e) {
          g.UI.toast('初始化失败：' + (e && e.message ? e.message : '网络错误'), 'err');
        });
        return;
      }
      var gs = g.SHA256.randomId(12), us = g.SHA256.randomId(12);
      S.gate = { hash: hashPwd(gp, gs), salt: gs };
      var u = {
        id: uid('u'), nick: nick, note: '站长', status: 'active', pwdHash: hashPwd(pwd, us), pwdSalt: us,
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
      /* 在线模式：保护密码由服务端校验，本地根本不存这个哈希 */
      if (g.Online && g.Online.isOnline()) {
        g.Online.gate(p).then(function () {
          sessionStorage.setItem(GATE_KEY, '1');
          return g.Online.pull();
        }).then(function (inS) {
          if (inS && mergeState(inS)) save(true);
          afterGate();
        }).catch(function (e) {
          g.UI.toast('密码错误或网络异常', 'err');
        });
        return;
      }
      var gv = verifyPwd(p, S.gate.salt, S.gate.hash);
      if (!gv.ok) { g.UI.toast('密码错误', 'err'); return; }
      if (gv.legacy) { S.gate.hash = hashPwd(p, S.gate.salt); save(); }
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
      '<div class="gate-title">登录</div><div class="gate-sub">' + g.UI.esc(S.siteName || '聊天室') + '</div>' +
      '<div class="tabs"><button class="tab on" data-t="login">登录</button><button class="tab" data-t="reg">注册</button></div>' +
      '<div id="pane"></div>';
    wrap.appendChild(card);
    wrap.classList.remove('hidden');
    wrap.style.display = 'flex';
    function pane(t) {
      var p = card.querySelector('#pane');
      Array.prototype.forEach.call(card.querySelectorAll('.tab'), function (b) { b.classList.toggle('on', b.dataset.t === t); });
      if (t === 'login') {
        p.innerHTML =
          '<label class="field-label">昵称</label><input class="field" id="lNick" placeholder="你的昵称">' +
          '<label class="field-label">登录密码</label><input class="field" id="lPwd" type="password">' +
          '<button class="btn primary block" id="lOk">登录</button>';
        var ok = function () {
          /* 在线模式：登录走服务端。本地根本没有 pwdHash（服务端从不返回）。
             这段必须放在本地校验之前 —— 服务端用户的 pwdHash 是空的，
             走本地分支必然判「密码错误」。 */
          if (g.Online && g.Online.isOnline()) {
            var ln = card.querySelector('#lNick').value.trim();
            var lp = card.querySelector('#lPwd').value;
            if (!ln || !lp) { g.UI.toast('请填写昵称与密码'); return; }
            g.Online.login(ln, lp).then(function (r) {
              sessionStorage.setItem(ME_KEY, r.uid);
              return g.Online.pull().then(function (inS) {
                if (inS && mergeState(inS)) save(true);
                me = findUser(r.uid) || me;
                g.Online.startPoll();
                enterApp();
              });
            }).catch(function (e) {
              g.UI.toast((e && e.message) || '登录失败', 'err');
            });
            return;
          }
          var u = byNick(card.querySelector('#lNick').value);
          if (!u) { g.UI.toast('用户不存在', 'err'); return; }
          var lv = verifyPwd(card.querySelector('#lPwd').value, u.pwdSalt, u.pwdHash);
          if (!lv.ok) { g.UI.toast('密码错误', 'err'); return; }
          if (lv.legacy) { u.pwdHash = hashPwd(card.querySelector('#lPwd').value, u.pwdSalt); save(); }
          if (u.banned) { g.UI.toast('该账号已被封禁', 'err'); return; }
          if (u.status === 'pending') { g.UI.toast('申请已提交，请等待站长通过', 'err'); return; }
          if (u.status === 'rejected') {
            g.UI.toast('申请未通过：' + (u.rejectReason || '站长未说明理由'), 'err'); return;
          }
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
          (function () {
            var old = S.users.filter(function (x) { return x.status === 'rejected'; })[0];
            return old ? '<div class="form-tip warn">你上次提交的申请未通过：' +
              g.UI.esc(old.rejectReason || '站长未说明理由') + '。可修改说明后重新提交。</div>' : '';
          })() +
          '<label class="field-label">申请说明（写给站长看，站长据此决定是否通过）</label>' +
          '<textarea class="field" id="rNote" rows="3" placeholder="例如：我是高二3班的李明，想进来和同学讨论算法题"></textarea>' +
          '<label class="field-label">登录密码</label><input class="field" id="rPwd" type="password">' +
          '<label class="field-label">确认密码</label><input class="field" id="rPwd2" type="password">' +
          '<button class="btn primary block" id="rOk">提交申请</button>';
        var rok = function () {
          var n = card.querySelector('#rNick').value.trim();
          var note = card.querySelector('#rNote').value.trim();
          var a = card.querySelector('#rPwd').value, b = card.querySelector('#rPwd2').value;
          if (!n || !note) { g.UI.toast('请填写昵称与申请说明'); return; }
          if (byNick(n)) { g.UI.toast('昵称已被占用'); return; }
          if (a.length < 4) { g.UI.toast('密码至少 4 位'); return; }
          if (a !== b) { g.UI.toast('两次密码不一致'); return; }
          /* 在线模式：注册交给服务端，密码只在服务端 bcrypt */
          if (g.Online && g.Online.isOnline()) {
            g.Online.register(n, a).then(function () {
              g.UI.toast('申请已提交，请等待站长通过', 'ok');
              pane('login');
            }).catch(function (e) {
              g.UI.toast('注册失败：' + ((e && e.message) || '昵称可能已被占用'), 'err');
            });
            return;
          }
          var salt = g.SHA256.randomId(12);
          var needReview = S.needReview !== false;
          var u = {
            id: uid('u'), nick: n, note: note, pwdHash: hashPwd(a, salt), pwdSalt: salt,
            role: 'member', status: needReview ? 'pending' : 'active',
            perms: [], banned: false, mutedUntil: 0, bio: '',
            createdAt: now(), updatedAt: now(), lastSeen: now()
          };
          S.users.push(u);
          log('reg', '提交申请 ' + n + '：' + note.slice(0, 50));
          save(true);
          if (needReview) {
            g.UI.toast('申请已提交，请等待站长通过', 'ok');
            pane('login');
          } else {
            joinRoom('public', u, true);
            sessionStorage.setItem(ME_KEY, u.id);
            me = u;
            enterApp();
          }
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

  /* 显示当前数据存储位置（在线 / 本地） */
  function showModeTag() {
    var host = document.getElementById('modeTagHost');
    if (!host) return;
    host.style.display = '';
    var on = !!(g.Online && g.Online.isOnline());
    host.className = 'mode-tag ' + (on ? 'ok' : 'warn');
    host.textContent = on ? '云端模式 · 换设备可见'
                          : '本地模式 · 数据只在这台设备';
    host.title = on ? '消息与账号存在服务器' : '换浏览器或清除缓存会丢失';
  }

  function toggleSidebar() {
    var sb = $('sidebar');
    if (sb) sb.classList.toggle('show');
  }

  function enterApp() {
    $('gate').classList.add('hidden');
    $('gate').innerHTML = '';
    $('gate').style.display = 'none';
    $('app').classList.remove('hidden');
    $('app').style.display = '';
    ensurePublic();
    /* 顶部模式标识：让使用者随时知道这一刻的数据存在哪。
       原来整站只有贴吧页脚有一行小字，数据更多的聊天室反而没有任何提示。 */
    showModeTag();
    if (me.role === 'member' && !findRoom('public')) { }
    joinRoom('public', me, true);
    save(true);
    bindEvents();
    renderAll();
    g.Net.loadAccel().then(function (ok) { if (ok) g.UI.toast('已启用 C++/WASM 哈希加速', 'ok'); });
    startHeartbeat();
    setMode(getMode(), true);
    scrollBottom();
    /* 启动后检查：存储配额（所有人）+ 备份提醒（仅管理员） */
    setTimeout(function () {
      try { checkStorageQuota(); } catch (e) { }
      if (me.role === 'owner' || me.role === 'admin') {
        var last = S.lastBackup || 0;
        var days = (Date.now() - last) / 86400000;
        if (!last || days >= 7) {
          g.UI.toast(last ? ('距上次备份已 ' + Math.floor(days) + ' 天，建议导出一份 JSON')
            : '建议先导出一份 JSON 备份（管理面板 → 站点）', 'ok');
        }
      }
    }, 1500);
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
    if (r.type === 'public') return S.users.filter(function (u) { return u.status !== 'pending'; });
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

  /* 别人发来的消息：累计未读；若 @了我 则额外标记 */
  function noteIncoming(m) {
    if (!me || !m || m.from === me.id) return;
    if (m.room !== cur) {
      unread[m.room] = (unread[m.room] || 0) + 1;
      if (isAtMe(m)) atMe[m.room] = (atMe[m.room] || 0) + 1;
      renderRooms();
    } else if (isAtMe(m)) {
      g.UI.toast('有人 @ 了你', 'ok');
    }
  }

  /* ============ 正在输入提示 ============
   * 自己打字时通过 Sync 广播 typing，对方最多显示 3 秒。
   * 不落库、不进消息流，纯瞬时状态。
   */
  var typingAt = 0, typingShown = null;
  function markTyping() {
    var now2 = Date.now();
    if (now2 - typingAt < 1500) return;
    typingAt = now2;
    try {
      var bc2 = g.__syncBc;
      if (bc2) bc2.postMessage({ t: 'typing', from: me.id, room: cur, nick: me.nick, at: now2 });
    } catch (e) { }
  }
  function showTyping(nick) {
    var bar = $('typingBar');
    if (!bar) return;
    bar.textContent = nick + ' 正在输入…';
    bar.classList.remove('hidden');
    typingShown = nick;
    clearTimeout(showTyping._t);
    showTyping._t = setTimeout(function () { bar.classList.add('hidden'); typingShown = null; }, 3000);
  }

  /* 是否 @了我：@我的昵称 或 @全体成员 / @all */
  function isAtMe(m) {
    if (!me || !m) return false;
    var t = (m.text || '');
    if (!/@/.test(t)) return false;
    if (new RegExp('@' + escapeRe(me.nick) + '(?![\\w\\u4e00-\\u9fa5])').test(t)) return true;
    if (/@(全体成员|所有人|all)/.test(t)) return true;
    return false;
  }
  function escapeRe(x) { return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function isBottom() {
    var s = $('msgScroll');
    return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
  }
  function scrollBottom() {
    var s = $('msgScroll');
    if (s) s.scrollTop = s.scrollHeight;
  }

  /* ================= 渲染 ================= */
  /* 未登录（me 为 null）时不能做完整渲染 —— renderMe() 会读 me.nick 直接抛错。
     在线模式下 pull() 拿到数据后会在门禁阶段就回调渲染，必须先挡住。 */
  function renderAll() {
    if (!me) return;
    renderMe(); renderSidebar(); renderChat();
  }

  function renderMe() {
    var c = $('meCard');
    if (!c) return;
    c.innerHTML = '';
    if (!me) return;
    var a = g.UI.avatar(me, 'md');
    c.appendChild(a);
    var info = elc('div', 'me-info');
    info.innerHTML = '<div class="me-nick">' + g.UI.esc(me.nick) +
      '<span class="tag ' + (me.role === 'owner' ? 'green' : me.role === 'admin' ? 'blue' : 'gray') + '">' +
      g.ACL.roleName(me) + '</span></div>' +
      '<div class="me-sub">' + g.UI.esc(me.note || '未填写申请说明') + (g.ACL.muted(me) ? ' · 禁言中' : '') + '</div>';
    c.appendChild(info);
    var edit = elc('button', 'mini-btn', '资料');
    edit.onclick = openProfile;
    c.appendChild(edit);
  }

  function renderSidebar() {
    if (!me) return;
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
      var m = msgs(r.id).filter(visibleToMe), last = m.length ? m[m.length - 1] : null;
      var item = elc('div', 'room-item' + (r.id === cur ? ' on' : '') + ((unread[r.id] || 0) > 0 ? ' has-unread' : ''));
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

  /* 在线判定：以心跳时间为准。ONLINE_MS 内有过心跳才算在线，
     避免"关掉标签页但仍被计在线"的问题。 */
  var HEARTBEAT_MS = 15000;   /* 心跳间隔 */
  var ONLINE_MS = 45000;      /* 超过此时长无心跳视为离线 */

  function isOnline(u) {
    if (!u) return false;
    return (u.lastSeen || 0) > (now() - ONLINE_MS);
  }

  var hbTimer = null;
  function startHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);
    var beat = function () {
      if (!me) return;
      me.lastSeen = now();
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { }
      /* 轻量广播，让其他标签刷新在线状态 */
      g.Sync.ping();
      /* 只刷新在线人数，不整屏重绘 */
      refreshOnline();
    };
    beat();
    hbTimer = setInterval(beat, HEARTBEAT_MS);
  }

  function refreshOnline() {
    var r = findRoom(cur);
    if (!r) return;
    var mem = membersOf(r);
    var onlineN = mem.filter(function (u) { return isOnline(u); }).length;
    var sub = [];
    sub.push(r.type === 'public' ? '公屏大厅 · ' + onlineN + ' 人在线（共 ' + mem.length + ' 人）' :
      r.type === 'private' ? ('私聊 · ' + (isOnline(mem.find(function (u) { return u.id !== me.id; })) ? '对方在线' : '对方离线')) :
        ('群聊 · ' + onlineN + ' 人在线 / 共 ' + mem.length + ' 人'));
    if (r.pwd) sub.push('已加密');
    var rs = $('roomSub');
    if (rs) rs.textContent = sub.join(' · ');
    /* 成员面板在线点 */
    Array.prototype.forEach.call(document.querySelectorAll('#memberList .mem-dot'), function (d) {
      var id = d.getAttribute('data-uid');
      var u = id && findUser(id);
      if (u) d.classList.toggle('on', isOnline(u));
    });
  }

  /* ================= 极简模式 / 专业模式 =================
   * simple：只留「+」和表情，隐藏语法工具条与命令提示
   * pro：显示 Markdown / 公式工具条、语法帮助、代码语言标签、可看源码
   */
  var MODE_KEY = 'wxlg_mode';

  function getMode() {
    var m = null;
    try { m = localStorage.getItem(MODE_KEY); } catch (e) { }
    return (m === 'pro' || m === 'simple') ? m : 'pro';
  }
  function setMode(m, silent) {
    try { localStorage.setItem(MODE_KEY, m); } catch (e) { }
    document.body.classList.remove('mode-simple', 'mode-pro');
    document.body.classList.add('mode-' + m);
    var btn = $('btnMode');
    if (btn) {
      btn.textContent = m === 'simple' ? '极简' : '专业';
      btn.title = m === 'simple' ? '当前：极简模式（点此切到专业）' : '当前：专业模式（点此切到极简）';
    }
    renderChat();
    if (!silent) g.UI.toast(m === 'simple' ? '已切到极简模式' : '已切到专业模式', 'ok');
  }

  function renderChat() {
    if (!me) return;

    var r = findRoom(cur);
    if (!r) { cur = 'public'; r = findRoom('public'); }
    if (!r) return;
    $('roomTitle').textContent = roomTitleOf(r);
    var mem = membersOf(r);
    var sub = [];
    var onlineN = mem.filter(function (u) { return isOnline(u); }).length;
    sub.push(r.type === 'public' ? '公屏大厅 · ' + onlineN + ' 人在线（共 ' + mem.length + ' 人）' :
      r.type === 'private' ? ('私聊 · ' + (isOnline(mem.find(function (u) { return u.id !== me.id; })) ? '对方在线' : '对方离线')) :
        ('群聊 · ' + onlineN + ' 人在线 / 共 ' + mem.length + ' 人'));
    if (r.pwd) sub.push('已加密');
    $('roomSub').textContent = sub.join(' · ');

    /* 置顶消息 */
    renderPinned(r);

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

    /* 消息
     * 性能：每条消息的渲染结果按「id + 内容指纹」缓存。
     * 切房间或新消息到达时，未变化的消息直接复用缓存的 DOM 片段，
     * 不再重跑一遍 Markdown + LaTeX 分词。指纹里带上 ts/deleted/pinned，
     * 保证内容或状态一变就自动失效。 */
    var box = $('msgScroll');
    box.innerHTML = '';
    var full = msgs(r.id).filter(visibleToMe);
    var shown = Math.min(full.length, MSG_PAGE);
    var arr = full.slice(-shown);
    var lastDay = '';
    arr.forEach(function (m) {
      var d = new Date(m.ts);
      var day = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
      if (day !== lastDay) {
        lastDay = day;
        box.appendChild(elc('div', 'time-sep', g.UI.fmtTime(m.ts)));
      }
      box.appendChild(cachedMsgNode(m, r));
    });
    /* 还有更早的消息时，顶部放一个「加载更早」 */
    if (full.length > shown) {
      var more = elc('button', 'load-more', '▲ 加载更早的 ' + (full.length - shown) + ' 条');
      more.onclick = function () {
        MSG_PAGE += 300;
        renderChat();
        var sc = $('msgScroll');
        if (sc) sc.scrollTop = 0;
      };
      box.insertBefore(more, box.firstChild);
    }

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
      t.innerHTML = '<div class="user-line-name">' + g.UI.esc(u.nick) +
        '<span class="mem-dot' + (isOnline(u) ? ' on' : '') + '" data-uid="' + g.UI.esc(u.id) + '"></span>' +
        '</div>' +
        '<div class="user-line-role">' + g.ACL.roleName(u) + ' · ' + g.ACL.roomRole(u, r) +
        (isOnline(u) ? ' · 在线' : ' · 离线') + '</div>';
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
      bubble.textContent = m.removedBy
        ? ('该消息已被' + g.UI.esc(nick(findUser(m.removedBy)) || '管理员') + '移除')
        : (mine ? '你撤回了一条消息' : '该消息已被撤回');
      /* 管理员/站长可查看原文：撤回与移除都刻意保留内容，便于追溯 */
      if (g.ACL.can(me, 'msg.viewRaw', r)) {
        var see = elc('button', 'msg-act', '查看原文');
        see.onclick = function () {
          var d2 = elc('div', '');
          d2.innerHTML = '<div class="form-tip">来自：' + g.UI.esc(nick(findUser(m.from)) || '未知') +
            ' · ' + g.UI.fmtFull(m.ts) + '</div>' +
            '<div class="raw-box">' + g.UI.esc(m.type === 'text' ? (m.text || '') : msgSnippet(m)) + '</div>';
          g.UI.modal({ title: '被处置消息的原文', body: d2, okText: '关闭', cancelText: null });
        };
        bubble.appendChild(document.createElement('br'));
        bubble.appendChild(see);
      }
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
      /* 撤回：作者本人，限时 RECALL_MS 内 */
      if (mine && g.ACL.can(me, 'msg.recall', r) && (now() - (m.ts || 0)) < RECALL_MS) {
        var bR = elc('button', 'msg-act', '撤回');
        bR.onclick = function () { doRemove(m, 'recall'); };
        acts.appendChild(bR);
      }
      /* 移除：管理员处置他人消息（不限时） */
      if (!mine && g.ACL.can(me, 'msg.remove', r)) {
        var bM = elc('button', 'msg-act danger', '移除');
        bM.onclick = function () { doRemove(m, 'remove'); };
        acts.appendChild(bM);
      }
      /* 删除：任何人可用，只把自己这边隐藏掉，别人照常看到 */
      var bDel = elc('button', 'msg-act danger', '删除');
      bDel.title = '仅在我这里消失，其他人仍能看到';
      bDel.onclick = function () { doRemove(m, 'hide'); };
      acts.appendChild(bDel);
      /* 置顶：需 msg.pin 权限 */
      if (g.ACL.can(me, 'msg.pin', r)) {
        var bPin = elc('button', 'msg-act', (r.pinned && r.pinned.indexOf(m.id) >= 0) ? '取消置顶' : '置顶');
        bPin.onclick = function () { togglePin(m); };
        acts.appendChild(bPin);
      }
      /* Delete：物理删除，释放空间，仅站长 */
      if (me.role === 'owner') {
        var bPurge = elc('button', 'msg-act danger', 'Delete');
        bPurge.title = '物理删除：从数据里抹掉并释放媒体空间（不可恢复）';
        bPurge.onclick = function () {
          g.UI.confirm('Delete 这条消息？数据将被抹掉、媒体空间释放，不可恢复。', function () {
            doRemove(m, 'purge');
          });
        };
        acts.appendChild(bPurge);
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
      var play = elc('div', 'play-badge');
      play.innerHTML = '<svg class="ic ic-fill" aria-hidden="true"><use href="#i-play"/></svg>';
      play.onclick = function () { g.UI.lightbox(v.src, 'video', m.name); };
      wrap.appendChild(play);
    }
    if (m.type === 'voice') { wrap.appendChild(voiceNode(m)); }
    var cap = elc('div', 'media-cap', (m.name || '媒体') + (m.size ? ' · ' + g.Media.fmtSize(m.size) : ''));
    if (m.type === 'file') {
      var dl = elc('button', 'file-dl', '下载 ' + g.UI.esc(m.name || '文件'));
      dl.onclick = function () {
        g.Media.get(m.mediaId).then(function (u) {
          if (!u) { g.UI.toast('文件数据已丢失'); return; }
          var a = document.createElement('a');
          a.href = u; a.download = m.name || 'file'; a.click();
        });
      };
      wrap.appendChild(dl);
    }
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

    /* 在线模式：真发到服务端。
       先本地插入（乐观更新，界面不卡），服务端成功后会被下次 pull 覆盖为权威版本。 */
    if (g.Online && g.Online.isOnline()) {
      g.Online.sendMsg(cur, 'text', text, null, '', 0, m.replyTo || null)
        .catch(function (e) {
          g.UI.toast('发送失败：' + (e && e.message ? e.message : '网络错误'), 'err');
        });
    }
  }

  var RECALL_MS = 5 * 60 * 1000;   /* 撤回时限：5 分钟 */

  function doRemove(m, mode) {
    var r = findRoom(cur);
    if (!r) return;
    /* mode: recall 本人撤回 / remove 管理员移除 / purge 站长物理删除 */
    if (mode === 'recall') {
      if (m.from !== me.id) { g.UI.toast('只能撤回自己的消息', 'err'); return; }
      if ((now() - (m.ts || 0)) >= RECALL_MS) { g.UI.toast('超过 5 分钟，不能撤回了', 'err'); return; }
      m.deleted = true; m.removedBy = null;
      log('recall', '撤回自己的消息', r.id);
      save(); g.UI.toast('已撤回', 'ok');
    } else if (mode === 'remove') {
      if (m.from === me.id) { g.UI.toast('自己的消息请点「撤回」', 'err'); return; }
      m.deleted = true; m.removedBy = me.id;
      log('remove', '移除「' + nick(findUser(m.from)) + '」的消息', r.id);
      save(); g.UI.toast('已移除该消息', 'ok');
    } else if (mode === 'hide') {
      /* 删除：只把当前账号加入隐藏名单，消息对别人仍然可见 */
      m.hiddenFor = m.hiddenFor || [];
      if (m.hiddenFor.indexOf(me.id) < 0) m.hiddenFor.push(me.id);
      save();
      g.UI.toast('已删除（仅你这里不再显示）', 'ok');
      renderChat();
    } else {
      /* delete：原有的删除，全站生效——所有人都不再看到内容 */
      m.deleted = true;
      log('delete', 'delete 消息（来自「' + nick(findUser(m.from)) + '」）', r.id);
      save();
      g.UI.toast('已 delete', 'ok');
    }
  }

  /* 该消息对「我」是否可见：被隐藏或已被撤回/移除都算不可见 */
  function visibleToMe(m) {
    if (!m) return false;
    if (m.hiddenFor && me && m.hiddenFor.indexOf(me.id) >= 0) return false;
    return true;
  }

  /* 我隐藏了多少条消息（用于「恢复已删除」） */
  /* 消息摘要（进日志用，便于后台追溯被撤回/移除/Delete 的内容） */
  /* ================= 消息置顶 ================= */
  /* ---------- 消息渲染缓存 ---------- */
  var MSG_PAGE = 300;                 /* 当前渲染条数，点「加载更早」会增大 */
  var msgCache = Object.create(null); /* key -> { fp: 指纹, node: DOM 片段 } */
  var msgCacheOrder = [];
  var MSG_CACHE_MAX = 600;

  function msgFingerprint(m, r) {
    return [
      m.id, m.ts, m.type, m.text || '', m.mediaId || '', m.dur || 0, m.name || '',
      m.deleted ? 1 : 0, m.removedBy || '', m.quote ? (m.quote.id || m.quote.text || '') : '',
      (m.hiddenFor && m.hiddenFor.indexOf(me && me.id) >= 0) ? 1 : 0,
      (r.pinned && r.pinned.indexOf(m.id) >= 0) ? 1 : 0
    ].join('\u0001');
  }

  /* 说明：缓存的是「已渲染好的 DOM 片段」本身，不是克隆。
     外层包一个 .msg-cache-wrap（display:contents，不产生盒子），
     每次 renderChat 清空列表后它会回到游离状态，下次可原样复用——
     事件监听器一并保留，所以消息上的按钮照样能点。 */
  function cachedMsgNode(m, r) {
    var fp = msgFingerprint(m, r);
    var hit = msgCache[m.id];
    if (hit && hit.fp === fp && hit.node && !hit.node.parentNode) return hit.node;
    var wrap = document.createElement('div');
    wrap.className = 'msg-cache-wrap';
    wrap.appendChild(renderMsg(m, r));
    msgCache[m.id] = { fp: fp, node: wrap };
    msgCacheOrder.push(m.id);
    if (msgCacheOrder.length > MSG_CACHE_MAX) {
      var drop = msgCacheOrder.splice(0, msgCacheOrder.length - MSG_CACHE_MAX);
      drop.forEach(function (id) { delete msgCache[id]; });
    }
    return wrap;
  }

  function togglePin(m) {
    var r = findRoom(cur);
    if (!r) return;
    r.pinned = r.pinned || [];
    var i = r.pinned.indexOf(m.id);
    if (i >= 0) {
      r.pinned.splice(i, 1);
      log('unpin', '取消置顶消息', r.id);
      g.UI.toast('已取消置顶', 'ok');
    } else {
      r.pinned.push(m.id);
      log('pin', '置顶消息（' + msgSnippet(m) + '）', r.id);
      g.UI.toast('已置顶', 'ok');
    }
    save(); renderChat();
  }

  /* 置顶栏：显示在本会话顶部 */
  function renderPinned(r) {
    var host = $('pinnedBar');
    if (!host) return;
    host.innerHTML = '';
    if (!r.pinned || !r.pinned.length) { host.classList.add('hidden'); return; }
    var arr = msgs(r.id);
    var items = r.pinned.map(function (id) {
      return arr.filter(function (x) { return x.id === id; })[0];
    }).filter(function (x) { return x && visibleToMe(x) && !x.deleted; });
    if (!items.length) { host.classList.add('hidden'); return; }
    host.classList.remove('hidden');
    host.appendChild(elc('div', 'pinned-head', '📌 置顶 ' + items.length + ' 条'));
    items.forEach(function (m) {
      var row = elc('div', 'pinned-row');
      var txt = m.type === 'text' ? g.MD.plain(m.text || '') : msgSnippet(m);
      var lab = elc('span', 'pinned-txt');
      lab.innerHTML = '<b>' + g.UI.esc(nick(findUser(m.from)) || '未知') + '</b>：' +
        g.UI.esc(txt.length > 60 ? txt.slice(0, 60) + '…' : txt);
      row.appendChild(lab);
      row.onclick = function () {
        var nd = document.querySelector('[data-mid="' + m.id + '"]');
        if (nd) { nd.scrollIntoView({ block: 'center' }); nd.classList.add('flash'); setTimeout(function () { nd.classList.remove('flash'); }, 1200); }
      };
      if (g.ACL.can(me, 'msg.pin', r)) {
        var x = elc('button', 'pinned-x');
        x.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-close"/></svg>';
        x.title = '取消置顶';
        x.title = '取消置顶';
        x.onclick = function (e) { e.stopPropagation(); togglePin(m); };
        row.appendChild(x);
      }
      host.appendChild(row);
    });
  }

  function msgSnippet(m) {
    var t = '';
    if (m.type === 'text') t = g.MD.plain(m.text || '');
    else if (m.type === 'image') t = '[图片]';
    else if (m.type === 'video') t = '[视频]';
    else if (m.type === 'voice') t = '[语音 ' + (m.dur || 0) + '秒]';
    else if (m.type === 'file') t = '[文件 ' + (m.name || '') + ']';
    else t = '[' + (m.type || '消息') + ']';
    return t.length > 120 ? t.slice(0, 120) + '…' : t;
  }

  function hiddenCount() {
    var c = 0;
    Object.keys(S.messages).forEach(function (rid) {
      (S.messages[rid] || []).forEach(function (m) {
        if (m.hiddenFor && me && m.hiddenFor.indexOf(me.id) >= 0) c++;
      });
    });
    return c;
  }

  /* 恢复：把我隐藏的消息全部重新显示 */
  function restoreHidden() {
    var c = 0;
    Object.keys(S.messages).forEach(function (rid) {
      (S.messages[rid] || []).forEach(function (m) {
        if (m.hiddenFor && me && m.hiddenFor.indexOf(me.id) >= 0) {
          m.hiddenFor = m.hiddenFor.filter(function (x) { return x !== me.id; });
          c++;
        }
      });
    });
    save(); renderChat();
    g.UI.toast('已恢复 ' + c + ' 条消息', 'ok');
  }

  /* ================= 语音消息 =================
   * 用浏览器原生 MediaRecorder 录制，不联网、不依赖第三方服务。
   * 注意：录音需要麦克风权限，且仅在 https / localhost 下可用，
   *      file:// 直接打开时浏览器会拒绝，界面会给出提示。
   */
  var rec = null, recChunks = [], recTimer = null, recStart = 0;
  var VOICE_MAX_MS = 60000;

  function canRecord() {
    var okProto = location.protocol === 'https:' ||
      location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    return okProto && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
      typeof g.MediaRecorder !== 'undefined';
  }

  function startRecord() {
    var r = findRoom(cur);
    if (!r) return;
    var sp = g.ACL.canSpeak(me, r);
    if (!sp.ok) { g.UI.toast(sp.why, 'err'); return; }
    if (!g.ACL.can(me, 'media.voice', r)) { g.UI.toast('没有发送语音的权限', 'err'); return; }
    if (!canRecord()) {
      g.UI.toast('当前环境不支持录音。请用 https 访问或 python3 server.py 打开', 'err');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      recChunks = [];
      var mime = '';
      var cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
      for (var i = 0; i < cands.length; i++) {
        if (g.MediaRecorder.isTypeSupported && g.MediaRecorder.isTypeSupported(cands[i])) { mime = cands[i]; break; }
      }
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) { rec = new MediaRecorder(stream); }
      recStream(stream);
      rec.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
      rec.onstop = function () { finishRecord(stream); };
      rec.start();
      recStart = now();
      var tip = $('recTip'), sec = $('recSec');
      if (tip) tip.classList.remove('hidden');
      recTimer = setInterval(function () {
        var el = (now() - recStart) / 1000;
        if (sec) sec.textContent = Math.floor(el);
        if (now() - recStart >= VOICE_MAX_MS) stopRecord(true);
      }, 200);
      var bv = $('btnVoice');
      if (bv) { bv.classList.add('recording'); bv.textContent = '⏹'; }
    }).catch(function (e) {
      g.UI.toast('无法访问麦克风：' + (e && e.name ? e.name : '未知原因'), 'err');
    });
  }

  var recStreamRef = null;
  function recStream(s) { recStreamRef = s; }

  function stopRecord(auto) {
    if (!rec) return;
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
    try { rec.stop(); } catch (e) { finishRecord(recStreamRef); }
  }

  /* 误触录音的最后一道保险：
     进得去出不来的链条是「误触 🎙 → 唯一出口 ⏹ → ⏹ 的作用是发送」。
     ✕ 取消已补上，但真有人慌了直接按 ⏹ 呢？
     录制不足 800ms 视为误触 —— 不发送，直接丢弃并提示。
     （原来 Math.max(1,...) 会把 0.5 秒硬算成 1 秒照样发出去。） */
  var REC_MIN_MS = 800;

  function finishRecord(stream) {
    if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { } }
    var tip = $('recTip');
    if (tip) tip.classList.add('hidden');
    var bv = $('btnVoice');
    if (bv) { bv.classList.remove('recording'); bv.textContent = '🎙'; }
    if (recStart && (now() - recStart) < REC_MIN_MS) {
      recChunks = []; rec = null; recStart = 0;
      g.UI.toast('录音太短，已取消（未发送）', 'err');
      return;
    }
    var dur = Math.max(1, Math.round((now() - recStart) / 1000));
    if (!recChunks.length) return;
    var blob = new Blob(recChunks, { type: recChunks[0].type || 'audio/webm' });
    recChunks = [];
    rec = null;
    g.Media.readFile(blob).then(function (dataUrl) {
      var id = uid('v');
      return g.Media.put(id, dataUrl).then(function () {
        pushMsg({
          id: uid('msg'), room: cur, from: me.id, type: 'voice',
          mediaId: id, name: '语音消息', size: g.Media.dataUrlSize(dataUrl),
          dur: dur, ts: now()
        });
        g.UI.toast('已发送语音（' + dur + '秒）', 'ok');
      });
    });
  }

  function cancelRecord() {
    if (!rec) return;
    recChunks = [];
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
    try { rec.stop(); } catch (e) { }
    rec = null;
    var tip = $('recTip'); if (tip) tip.classList.add('hidden');
    var bv = $('btnVoice'); if (bv) { bv.classList.remove('recording'); bv.textContent = '🎙'; }
    g.UI.toast('已取消');
  }

  /* 语音气泡 */
  function voiceNode(m) {
    var wrap = elc('div', 'voice-msg');
    /* 播放按钮换成图标（实心）。切暂停态时替换整个 svg，不再改 textContent */
    var play = elc('button', 'voice-play');
    play.innerHTML = '<svg class="ic ic-fill" aria-hidden="true"><use href="#i-play"/></svg>';
    var bars = elc('div', 'voice-bars');
    var n = Math.max(6, Math.min(28, Math.round((m.dur || 1) * 1.6) + 6));
    for (var i = 0; i < n; i++) {
      var b = elc('span', 'vbar');
      b.style.height = (4 + Math.abs(Math.sin(i * 1.7)) * 14) + 'px';
      bars.appendChild(b);
    }
    var dur = elc('span', 'voice-dur', (m.dur || 1) + '"');
    wrap.appendChild(play);
    wrap.appendChild(bars);
    wrap.appendChild(dur);
    var audio = null;
    play.onclick = function () {
      if (audio && !audio.paused) { audio.pause(); audio.currentTime = 0; setPlayIcon(play); bars.classList.remove('playing'); return; }
      g.Media.get(m.mediaId).then(function (u) {
        if (!u) { g.UI.toast('语音数据已丢失'); return; }
        if (!audio) audio = new Audio(u);
        play.textContent = '⏸';
        bars.classList.add('playing');
        audio.onended = function () { setPlayIcon(play); bars.classList.remove('playing'); };
        audio.play().catch(function () { g.UI.toast('播放失败'); setPlayIcon(play); bars.classList.remove('playing'); });
      });
    };
    return wrap;
  }

  /* ================= 深色模式 ================= */
  var THEME_KEY = 'wxlg_theme';
  var ENTER_KEY = 'wxlg_enter';
  function enterSends() {
    try { return (localStorage.getItem(ENTER_KEY) || 'send') === 'send'; } catch (e) { return true; }
  }
  function applyTheme(t) {
    var b = document.body;
    if (!t || t === 'auto') {
      var dark = g.matchMedia && g.matchMedia('(prefers-color-scheme: dark)').matches;
      b.classList.toggle('dark', !!dark);
    } else {
      b.classList.toggle('dark', t === 'dark');
    }
  }
  function initTheme() {
    var t = 'auto';
    try { t = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { }
    applyTheme(t);
    if (g.matchMedia) {
      var mq = g.matchMedia('(prefers-color-scheme: dark)');
      var h = function () { if ((localStorage.getItem(THEME_KEY) || 'auto') === 'auto') applyTheme('auto'); };
      if (mq.addEventListener) mq.addEventListener('change', h);
      else if (mq.addListener) mq.addListener(h);
    }
  }
  function setTheme(t) {
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { }
    applyTheme(t);
  }

  /* ================= 导出聊天记录 ================= */
  function exportChat(fmt) {
    var r = findRoom(cur);
    var list = (msgs(cur) || []).filter(function (m) { return !m.deleted; }).filter(visibleToMe);
    if (!list.length) { g.UI.toast('当前会话没有消息'); return; }
    var nameOf = function (id) { var u = findUser(id); return u ? u.nick : '未知'; };
    var head = '# ' + (r ? r.name : cur) + '\n\n导出时间：' + new Date().toLocaleString('zh-CN') +
      '\n共 ' + list.length + ' 条消息\n\n';
    var typeText = function (m) {
      if (m.type === 'image') return '[图片]';
      if (m.type === 'video') return '[视频]';
      if (m.type === 'voice') return '[语音 ' + (m.dur || 0) + '秒]';
      if (m.type === 'file') return '[文件 ' + (m.name || '') + ']';
      return m.text || '';
    };
    var body;
    if (fmt === 'md') {
      body = list.map(function (m) {
        return '**' + nameOf(m.from) + '**（' + g.UI.fmtFull(m.ts) + '）\n\n' + typeText(m) + '\n';
      }).join('\n---\n\n');
    } else {
      body = list.map(function (m) {
        var t = m.type === 'text' ? g.MD.plain(m.text || '') : typeText(m);
        return '[' + g.UI.fmtFull(m.ts) + '] ' + nameOf(m.from) + '：' + t;
      }).join('\n');
    }
    var blob = new Blob([head + body], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (r ? r.name : cur).replace(/[\/:*?"<>|]/g, '_') + '-' +
      new Date().toISOString().slice(0, 10) + '.' + (fmt === 'md' ? 'md' : 'txt');
    a.click();
    g.UI.toast('已导出', 'ok');
  }

  function markBackup() { S.lastBackup = Date.now(); save(true); }

  function exportDialog() {
    var rn = findRoom(cur) ? findRoom(cur).name : cur;
    var d = elc('div', '');
    d.innerHTML = '<div class="form-tip">导出当前会话「' + g.UI.esc(rn) + '」的全部消息。</div>' +
      '<div class="field-hint">Markdown 保留代码块、表格与公式源码；文本格式为纯文字便于阅读。</div>';
    g.UI.modal({
      title: '导出聊天记录', body: d, okText: '导出 Markdown', cancelText: '导出文本',
      onOk: function () { exportChat('md'); },
      onCancel: function () { exportChat('txt'); }
    });
  }

  /* ================= 存储配额 ================= */
  function storageInfo() {
    var used = 0;
    try { used = (localStorage.getItem(KEY) || '').length; } catch (e) { }
    var mediaCount = 0;
    Object.keys(S.messages).forEach(function (rid) {
      (S.messages[rid] || []).forEach(function (m) { if (m.mediaId && !m.deleted) mediaCount++; });
    });
    return { stateKB: Math.round(used / 1024), mediaCount: mediaCount, quotaKB: 5120 };
  }

  function checkStorageQuota() {
    var st = storageInfo();
    if (st.stateKB > st.quotaKB * 0.8) {
      g.UI.toast('本地存储已用 ' + st.stateKB + ' KB（约 5 MB 上限），建议到「站点」导出备份后清理', 'err', 6000);
    }
  }

  /* ================= 旧媒体清理（先备份再问站长） ================= */
  function mediaCleanDialog() {
    if (!(g.ACL.can(me, 'site.clean') || me.role === 'owner')) {
      g.UI.toast('仅站长 / 管理员可清理媒体'); return;
    }
    var st = storageInfo();
    var d = elc('div', '');
    d.innerHTML =
      '<div class="form-tip">当前有 <b>' + st.mediaCount + '</b> 个媒体文件（图片 / 视频 / 语音 / 附件），' +
      '状态数据约 ' + st.stateKB + ' KB。</div>' +
      '<label class="field-label">清理早于多少天的媒体</label><select class="field" id="mcDays">' +
      '<option value="7">7 天前</option><option value="30" selected>30 天前</option>' +
      '<option value="90">90 天前</option></select>' +
      '<div class="form-tip danger">⚠️ 必须先导出备份。清理后这些消息的媒体无法显示（消息本身保留）。</div>' +
      '<button class="btn ghost" id="mcBackup">第一步：导出 JSON 备份</button>' +
      '<div id="mcTip" class="field-hint"></div>';
    var backed = false;
    g.UI.modal({
      title: '清理旧媒体', body: d, okText: '第二步：确认清理', danger: true,
      onOk: function (body) {
        if (!backed) {
          body.querySelector('#mcTip').textContent = '请先点「导出 JSON 备份」完成备份，再执行清理。';
          return false;
        }
        var days = parseInt(body.querySelector('#mcDays').value, 10);
        var cut = Date.now() - days * 86400000;
        var cnt = 0;
        Object.keys(S.messages).forEach(function (rid) {
          (S.messages[rid] || []).forEach(function (m) {
            if (m.mediaId && (m.ts || 0) < cut) {
              try { g.Media.del(m.mediaId); } catch (e) { }
              m.mediaId = null; m.cleared = true; cnt++;
            }
          });
        });
        save();
        log('clean', '清理 ' + days + ' 天前的媒体，共 ' + cnt + ' 个');
        g.UI.toast('已清理 ' + cnt + ' 个媒体文件', 'ok');
        renderChat();
      }
    });
    d.querySelector('#mcBackup').onclick = function () {
      var blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'chat-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      backed = true;
      d.querySelector('#mcTip').textContent = '✓ 备份已下载，现在可以执行清理了。';
      log('backup', '清理前导出备份');
    };
  }

  /* ================= 邀请口令 =================
   * 群主/管理员生成一次性口令（可设有效期与使用次数），
   * 别人在房间列表输入口令即可入群，无需逐个邀请。
   */
  function genCode() {
    var cs = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var r = '';
    for (var i = 0; i < 6; i++) r += cs.charAt(Math.floor(Math.random() * cs.length));
    return r;
  }

  function inviteCodeDialog(r) {
    var d = elc('div', '');
    d.innerHTML =
      '<div class="form-tip">生成的口令发给对方，对方在「加入房间」里输入即可入群。</div>' +
      '<label class="field-label">有效时长</label><select class="field" id="icHour">' +
      '<option value="1">1 小时</option><option value="24" selected>1 天</option>' +
      '<option value="168">7 天</option><option value="0">长期有效</option></select>' +
      '<label class="field-label">可用次数</label><select class="field" id="icUse">' +
      '<option value="1">1 次</option><option value="5" selected>5 次</option>' +
      '<option value="0">不限次数</option></select>' +
      '<div id="icOut" class="invite-out"></div>';
    g.UI.modal({
      title: '生成邀请口令 · ' + r.name, body: d, okText: '生成', onOk: function (body) {
        var h = parseInt(body.querySelector('#icHour').value, 10);
        var u = parseInt(body.querySelector('#icUse').value, 10);
        var code = genCode();
        S.invites = S.invites || [];
        S.invites.push({
          code: code, room: r.id, by: me.id,
          expireAt: h > 0 ? Date.now() + h * 3600000 : 0,
          maxUse: u, used: 0, createdAt: Date.now()
        });
        save();
        var out = body.querySelector('#icOut');
        out.innerHTML = '<div class="invite-code">' + code + '</div>' +
          '<div class="field-hint">有效期：' + (h > 0 ? h + ' 小时' : '长期') +
          ' · 可用 ' + (u > 0 ? u + ' 次' : '不限次数') + '</div>' +
          '<button class="btn ghost" id="icCopy">复制口令</button>';
        body.querySelector('#icCopy').onclick = function () {
          try { navigator.clipboard.writeText(code); g.UI.toast('已复制', 'ok'); }
          catch (e) { g.UI.toast('复制失败，请手动记下：' + code); }
        };
        log('invite', '为「' + r.name + '」生成邀请口令');
        return false;   /* 保持弹窗打开，便于看到口令 */
      }
    });
  }

  /* 用口令加入房间 */
  function joinByCode() {
    var d = elc('div', '');
    d.innerHTML =
      '<label class="field-label">邀请口令</label><input class="field" id="jcCode" placeholder="6 位口令" maxlength="6">' +
      '<div id="jcMsg" class="field-hint"></div>';
    g.UI.modal({
      title: '用口令加入房间', body: d, okText: '加入', onOk: function (body) {
        var c = (body.querySelector('#jcCode').value || '').trim().toUpperCase();
        if (!c) { g.UI.toast('请输入口令'); return false; }
        var inv = (S.invites || []).filter(function (x) { return x.code === c; })[0];
        var tip = body.querySelector('#jcMsg');
        if (!inv) { tip.textContent = '口令不存在或已失效'; return false; }
        if (inv.expireAt && inv.expireAt < Date.now()) { tip.textContent = '口令已过期'; return false; }
        if (inv.maxUse > 0 && inv.used >= inv.maxUse) { tip.textContent = '口令使用次数已用完'; return false; }
        var r = findRoom(inv.room);
        if (!r) { tip.textContent = '目标房间已被解散'; return false; }
        joinRoom(inv.room, me, true);
        inv.used = (inv.used || 0) + 1;
        save();
        openRoom(inv.room);
        g.UI.toast('已加入「' + r.name + '」', 'ok');
      }
    });
  }

  /* ================= 消息搜索 ================= */
  function searchModal() {
    var d = elc('div', '');
    d.innerHTML =
      '<label class="field-label">关键词</label><input class="field" id="swK" placeholder="搜索聊天内容">' +
      '<label class="field-label">范围</label><select class="field" id="swScope">' +
      '<option value="cur">当前会话</option><option value="all">全部房间</option></select>' +
      '<label class="field-label">发送者（留空为全部）</label><input class="field" id="swWho" placeholder="昵称">' +
      '<div id="swList" class="search-list"></div>';
    var box = d.querySelector('#swList');
    var run = function () {
      var k = (d.querySelector('#swK').value || '').trim().toLowerCase();
      varwho = (d.querySelector('#swWho').value || '').trim().toLowerCase();
      var scope = d.querySelector('#swScope').value;
      box.innerHTML = '';
      if (!k) { box.appendChild(elc('div', 'empty-tip', '输入关键词开始搜索')); return; }
      var hits = [];
      Object.keys(S.messages).forEach(function (rid) {
        if (scope === 'cur' && rid !== cur) return;
        (S.messages[rid] || []).forEach(function (m) {
          if (m.deleted) return;
          var txt = (m.text || '');
          if (m.type !== 'text' && !txt) txt = '[' + (m.type === 'image' ? '图片' : m.type === 'video' ? '视频' : m.type === 'voice' ? '语音' : m.type === 'file' ? '文件' : '消息') + ']';
          if (txt.toLowerCase().indexOf(k) < 0) return;
          if (varwho) {
            var u = findUser(m.from);
            if (!u || u.nick.toLowerCase().indexOf(varwho) < 0) return;
          }
          hits.push({ m: m, rid: rid, txt: txt });
        });
      });
      if (!hits.length) { box.appendChild(elc('div', 'empty-tip', '没有找到相关消息')); return; }
      hits.sort(function (a, b) { return (b.m.ts || 0) - (a.m.ts || 0); });
      var tip = elc('div', 'field-hint', '共 ' + hits.length + ' 条，按时间倒序');
      box.appendChild(tip);
      hits.slice(0, 60).forEach(function (h) {
        var it = elc('div', 'search-item');
        var u = findUser(h.m.from);
        var rn = findRoom(h.rid);
        it.innerHTML = '<div class="search-meta">' + g.UI.esc(u ? u.nick : '未知') +
          ' · ' + g.UI.esc(rn ? rn.name : h.rid) + ' · ' + g.UI.fmtFull(h.m.ts) + '</div>' +
          '<div class="search-body">' + g.UI.esc(h.txt.slice(0, 120)) + '</div>';
        it.onclick = function () {
          openRoom(h.rid);
          setTimeout(function () {
            var nd = document.querySelector('[data-mid="' + h.m.id + '"]');
            if (nd) { nd.scrollIntoView({ block: 'center' }); nd.classList.add('flash'); setTimeout(function () { nd.classList.remove('flash'); }, 1200); }
          }, 200);
        };
        box.appendChild(it);
      });
    };
    d.querySelector('#swK').oninput = run;
    d.querySelector('#swWho').oninput = run;
    d.querySelector('#swScope').onchange = run;
    g.UI.modal({ title: '消息搜索', body: d, okText: '关闭', cancelText: null, wide: true });
    run();
  }

  /* ================= 表情面板 ================= */
  var EMOJI = [
    { t: '常用', e: ['😀','😄','😁','😂','🤣','😊','😍','😘','😎','🤔','😅','😭','😉','🙃','😴','🤗'] },
    { t: '手势', e: ['👍','👎','👌','✌','🤝','👏','🙏','💪','👋','🫡','🤙','👀'] },
    { t: '心情', e: ['❤','💔','✨','🔥','🎉','💯','⭐','🌈','☀','🌙','⚡','❄'] },
    { t: '学习', e: ['📚','✏','📝','💡','🧠','💻','⌨','🖥','📐','🔢','🧮','🎓'] },
    { t: '其他', e: ['🐱','🐶','🌸','🍎','🍜','☕','⚽','🎮','🎵','🚀','⏰','📌'] }
  ];

  function emojiPanel() {
    var d = elc('div', 'emoji-panel');
    EMOJI.forEach(function (grp) {
      var sec = elc('div', 'emoji-sec');
      sec.appendChild(elc('div', 'emoji-title', grp.t));
      var box = elc('div', 'emoji-grid');
      grp.e.forEach(function (c) {
        var b = elc('button', 'emoji-cell', c);
        b.onclick = function () {
          var ta = $('input');
          if (ta) {
            var st = ta.selectionStart || ta.value.length;
            ta.value = ta.value.slice(0, st) + c + ta.value.slice(st);
            ta.focus(); drafts[cur] = ta.value;
          }
        };
        box.appendChild(b);
      });
      sec.appendChild(box);
      d.appendChild(sec);
    });
    g.UI.modal({ title: '表情', body: d, okText: '关闭', cancelText: null });
  }

  /* ================= 公式符号面板 ================= */
  var SYMS = [
    { t: '基础', s: [['分数','\\frac{a}{b}'],['根号','\\sqrt{x}'],['n次根','\\sqrt[n]{x}'],['上下标','x^{2}_{1}'],['绝对值','|x|']] },
    { t: '希腊', s: [['α','\\alpha'],['β','\\beta'],['γ','\\gamma'],['π','\\pi'],['θ','\\theta'],['λ','\\lambda'],['μ','\\mu'],['σ','\\sigma'],['Ω','\\Omega'],['Δ','\\Delta']] },
    { t: '运算', s: [['求和','\\sum_{i=1}^{n}'],['积分','\\int_{0}^{1}'],['极限','\\lim_{x \\to 0}'],['连乘','\\prod_{i=1}^{n}'],['偏导','\\partial']] },
    { t: '关系', s: [['≤','\\le'],['≥','\\ge'],['≠','\\ne'],['≈','\\approx'],['±','\\pm'],['×','\\times'],['÷','\\div'],['∈','\\in'],['∞','\\infty']] },
    { t: '结构', s: [['矩阵','\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}'],['分段','\\begin{cases}1&x>0\\\\0&x\\le 0\\end{cases}'],['向量','\\vec{a}'],['文本','\\text{中文}']] }
  ];

  function symbolPanel() {
    var d = elc('div', 'sym-panel');
    SYMS.forEach(function (grp) {
      var sec = elc('div', 'sym-sec');
      sec.appendChild(elc('div', 'sym-title', grp.t));
      var box = elc('div', 'sym-grid');
      grp.s.forEach(function (it) {
        var b = elc('button', 'sym-cell');
        b.innerHTML = '<span class="sym-name">' + g.UI.esc(it[0]) + '</span>';
        b.title = it[1];
        b.onclick = function () {
          var ta = $('input');
          if (ta) {
            var st = ta.selectionStart || ta.value.length;
            ta.value = ta.value.slice(0, st) + it[1] + ta.value.slice(st);
            ta.focus(); drafts[cur] = ta.value;
          }
        };
        box.appendChild(b);
      });
      sec.appendChild(box);
      d.appendChild(sec);
    });
    d.appendChild(elc('div', 'field-hint', '点击插入到光标处。公式需用 $ 或 $$ 包裹才会渲染。'));
    g.UI.modal({ title: '公式符号', body: d, okText: '关闭', cancelText: null, wide: true });
  }

  /* 把媒体同步到云端。失败静默降级为本地（消息照发，只是跨设备看不到）。
     上传成功后再更新消息的 mediaPath，让其他设备能取到。 */
  function uploadRemote(m, dataUrl) {
    if (!g.Online || !g.Online.isOnline() || !g.Media.toBlob) return;
    var blob = g.Media.toBlob(dataUrl);
    if (!blob) return;
    g.Online.uploadMedia(m.room, m.name || '', blob).then(function (slot) {
      m.mediaPath = slot.path;
      /* 回填到服务端消息记录，其他设备才能知道去哪取 */
      if (g.SB && g.SB.rpc) {
        g.SB.rpc('msg_media', { p_msg: m.id, p_media: slot.path }).catch(function () { });
      }
      save(true);
    }).catch(function (e) {
      /* 降级不静默：这条消息在本机看得到、换设备看不到，得让人知道 */
      g.UI.toast('已发送（本机可见），云端上传失败：' + ((e && e.message) || '未知原因'), 'err');
    });
  }

  function sendMediaFile(file, kind) {
    var r = findRoom(cur);
    var sp = g.ACL.canSpeak(me, r);
    if (!sp.ok) { g.UI.toast(sp.why, 'err'); return; }
    /* 按类型细分权限：图片 / 视频 / 语音 / 文件各自独立 */
    var mediaPerm = { image: 'media.image', video: 'media.video', voice: 'media.voice', file: 'media.file' }[kind];
    if (mediaPerm && !g.ACL.can(me, mediaPerm, r)) {
      g.UI.toast('没有发送' + ({ image: '图片', video: '视频', voice: '语音', file: '文件' }[kind] || '该类型') + '的权限', 'err');
      return;
    }
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
          return (kind === 'video'
            ? g.Media.videoPoster(u).then(function (p) { if (p) m.poster = p; return m; })
                .catch(function () { return m; })
            : Promise.resolve(m)).then(function (mm) {
              /* 在线模式：同时往云端传一份，换设备才看得到。
                 本地已经存好了，云端失败不影响这条消息发出去 ——
                 只是对方换设备看不到，所以失败要提示。 */
              uploadRemote(mm, u);
              return mm;
            });
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
        var names = membersOf(r).map(function (u) { return u.nick; }).join('、');
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
        syncMute(u2, min);
        sysMsg(cur, '「' + u2.nick + '」被禁言 ' + min + ' 分钟'); log('mute', u2.nick + ' ' + min + '分钟', r.id); save(); return;
      }
      case 'unmute': {
        var u3 = byNick(rest.split(/\s+/)[0] || '');
        if (!u3 || !g.ACL.can(me, 'user.mute', r)) { g.UI.toast('用法：/unmute @昵称'); return; }
        u3.mutedUntil = 0; touch(u3); sysMsg(cur, '「' + u3.nick + '」已被解除禁言'); log('unmute', u3.nick, r.id); save(); return;
      }
      case 'kick': {
        var u4 = byNick(rest.split(/\s+/)[0] || '');
        if (!u4 || !g.ACL.can(me, 'room.kick', r)) { g.UI.toast('用法：/kick @昵称（或权限不足）', 'err'); return; }
        if (r.type === 'public') { g.UI.toast('公屏大厅不能踢人', 'err'); return; }
        r.members = (r.members || []).filter(function (x) { return x !== u4.id; });
        touch(r); sysMsg(cur, '「' + u4.nick + '」已被移出群聊'); log('kick', u4.nick, r.id); save(); renderAll();

        /* 在线模式：同步到服务端。失败要回滚本地，
           否则本地显示已踢、服务端还在群里。 */
        if (g.Online && g.Online.isOnline()) {
          g.Online.removeMember(r.id, u4.id).catch(function (e) {
            r.members = (r.members || []).concat([u4.id]);
            save(true); renderAll();
            g.UI.toast('操作失败：' + ((e && e.message) || '网络错误'), 'err');
          });
        }
        return;
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
        touch(r); sysMsg(cur, '「' + u8.nick + '」已被撤销群管理员'); log('revoke', u8.nick, r.id); save();
        if (g.Online && g.Online.isOnline()) {
          g.Online.setAdmin(r.id, u8.id, false).catch(function (e) {
            r.admins.push(u8.id); save(true);   /* 回滚 */
            g.UI.toast('操作失败：' + ((e && e.message) || '网络错误'), 'err');
          });
        }
        return;
      }
      case 'invite': {
        var u9 = byNick(rest.split(/\s+/)[0] || '');
        if (!u9) { g.UI.toast('用法：/invite @昵称'); return; }
        if (!g.ACL.can(me, 'room.manage', r)) { g.UI.toast('没有邀请权限', 'err'); return; }
        joinRoom(r.id, u9); save();
        if (g.Online && g.Online.isOnline()) {
          g.Online.addMember(r.id, u9.id).catch(function (e) {
            g.UI.toast('已加入本地，但服务端同步失败：' + ((e && e.message) || '网络错误'), 'err');
          });
        }
        return;
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
        if (!g.ACL.can(me, 'msg.remove', r)) { g.UI.toast('没有清空权限', 'err'); return; }
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
      'LaTeX（用 $ 包裹）：$x^2+y^2=z^2$、$$\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$$、$$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$$</div>';
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
    /* 保存上一个会话的草稿 */
    if (cur) {
      var ta = $('input');
      if (ta) {
        if (ta.value.trim()) drafts[cur] = ta.value;
        else delete drafts[cur];
      }
    }
    var keep = cur;
    doOpenRoom(rid);
    /* 恢复目标会话的草稿 */
    var tb = $('input');
    if (tb) { tb.value = drafts[rid] || ''; autoGrow(tb); }
    if (keep !== rid) g.Sync.ping();
  }

  function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  }

  function doOpenRoom(rid) {
    var r = findRoom(rid);
    if (!r) return;
    if (r.pwd && r.members && r.members.indexOf(me.id) < 0) {
      g.UI.prompt('需要群密码', '请输入「' + r.name + '」的进入密码', '', function (v) {
        var rv = verifyPwd(v, r.pwd.salt, r.pwd.hash);
        if (!rv.ok) { g.UI.toast('密码错误', 'err'); return; }
        if (rv.legacy) { r.pwd.hash = hashPwd(v, r.pwd.salt); save(); }
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
        var cMem = body.querySelector('#cMem');
        var r = {
          id: uid('r'), name: nm, type: 'group', desc: body.querySelector('#cDesc').value.trim(),
          owner: me.id, admins: [], members: [me.id], pwd: null,
          notice: '', muted: [], createdAt: now(), updatedAt: now()
        };
        if (pwd) { var s = g.SHA256.randomId(12); r.pwd = { hash: hashPwd(pwd, s), salt: s }; }
        cMem.value.split(/[,，\s]+/).forEach(function (n) {
          if (!n) return;
          var u = byNick(n);
          if (u && r.members.indexOf(u.id) < 0) r.members.push(u.id);
        });
        /* 在线模式：群必须在服务端建，否则换设备就没了。
           服务端返回真实 id，用它替换本地临时 id。 */
        if (g.Online && g.Online.isOnline()) {
          /* 一律走 Online 封装，不要直接 g.SB.rpc ——
             绕过封装等于绕过"写操作只走带鉴权 RPC"这条约定，
             新模块当天就被自己人开了后门。 */
          g.Online.createRoom(nm, r.desc, pwd || null)
            .then(function (rid) {
              if (rid) {
                r.id = rid;                 /* 用服务端 id，丢弃本地 uid('r') */
                var failed = [];
                var jobs = [];
                cMem.value.split(/[,，\s]+/).forEach(function (n) {
                  if (!n) return;
                  var u = byNick(n);
                  if (u && r.members.indexOf(u.id) < 0) {
                    r.members.push(u.id);
                    /* 加人失败必须让用户知道。
                       原来 .catch() 静默吞掉：群建好了、人没进去、毫无提示。 */
                    jobs.push(
                      g.Online.addMember(rid, u.id).catch(function () { failed.push(n); })
                    );
                  }
                });
                return Promise.all(jobs).then(function () {
                  S.rooms.push(r);
                  log('create', nm, r.id);
                  save(true);
                  openRoom(r.id);
                  if (failed.length) {
                    g.UI.toast('群已创建，但以下成员添加失败：' + failed.join('、'), 'err');
                  }
                });
              }
              S.rooms.push(r);
              log('create', nm, r.id);
              save(true);
              openRoom(r.id);
            })
            .catch(function (e) {
              g.UI.toast('创建失败：' + ((e && e.message) || '网络错误'), 'err');
            });
          return true;      /* 先关弹窗，等服务端返回后再进群 */
        }
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
    items.push(['用口令加入房间', function () { joinByCode(); }]);
    if (g.ACL.can(me, 'room.manage', r)) {
      items.push(['生成邀请口令', function () { inviteCodeDialog(r); }]);
    }
    if (g.ACL.can(me, 'room.manage', r)) items.push(['导出本群记录', function () { cur = r.id; exportDialog(); }]);
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
        var nm = body.querySelector('#sName').value.trim() || r.name;
        var ds = body.querySelector('#sDesc').value.trim();
        r.name = nm; r.desc = ds;
        touch(r); log('roomset', r.name, r.id); save();
        /* 在线模式：推到服务端，否则换设备群名就回退了 */
        if (g.Online && g.Online.isOnline()) {
          g.Online.updateRoom(r.id, nm, ds, r.notice || '').catch(function (e) {
            g.UI.toast('保存失败：' + ((e && e.message) || '网络错误'), 'err');
          });
        }
      }
    });
    var ab = d.querySelector('#sAdmin');
    membersOf(r).forEach(function (u) {
      var b = elc('button', 'chip' + (r.admins.indexOf(u.id) >= 0 ? ' on' : ''), u.nick + (r.admins.indexOf(u.id) >= 0 ? ' ✓' : ''));
      b.onclick = function () {
        if (!g.ACL.can(me, 'user.grant', r)) { g.UI.toast('无授权权限', 'err'); return; }
        var i = r.admins.indexOf(u.id);
        var want = i < 0;                       /* true = 设为管理员 */
        if (i >= 0) r.admins.splice(i, 1); else r.admins.push(u.id);
        touch(r); save(true); mo.close(); roomSettings(r);
        if (g.Online && g.Online.isOnline()) {
          g.Online.setAdmin(r.id, u.id, want).catch(function (e) {
            /* 失败要回滚本地，否则界面显示是管理员、服务端不是 */
            if (want) { var k = r.admins.indexOf(u.id); if (k >= 0) r.admins.splice(k, 1); }
            else r.admins.push(u.id);
            save(true); roomSettings(r);
            g.UI.toast('操作失败：' + ((e && e.message) || '网络错误'), 'err');
          });
        }
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
      '<div class="uc-real">申请说明：' + g.UI.esc(u.note || '未填写') + '</div>' +
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
        if (g.ACL.muted(u)) { u.mutedUntil = 0; touch(u); save(); syncMute(u, 0); }
        else {
          g.UI.prompt('禁言时长', '分钟', '10', function (v) {
            var m = parseInt(v, 10) || 10;
            u.mutedUntil = now() + m * 60000; touch(u); syncMute(u, m);
            sysMsg(r.id, '「' + u.nick + '」被禁言 ' + m + ' 分钟'); log('mute', u.nick, r.id); save();
          });
        }
      });
    }
    if (g.ACL.can(me, 'room.kick', r) && r.type !== 'public') {
      btn('移出本群', '', function () {
        r.members = (r.members || []).filter(function (x) { return x !== u.id; });
        touch(r); sysMsg(r.id, '「' + u.nick + '」已被移出群聊'); log('kick', u.nick, r.id); save(); renderAll();

        /* 在线模式：同步到服务端。失败要回滚本地，
           否则本地显示已踢、服务端还在群里。 */
        if (g.Online && g.Online.isOnline()) {
          g.Online.removeMember(r.id, u.id).catch(function (e) {
            r.members = (r.members || []).concat([u.id]);
            save(true); renderAll();
            g.UI.toast('操作失败：' + ((e && e.message) || '网络错误'), 'err');
          });
        }
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

  /* ============================================================
   * 权限编辑器：逐项分化
   *   每项三态 —— 继承 / 允许 / 禁止
   *   站长恒为全部权限，不显示可改。
   * ============================================================ */
  /* 把禁言状态同步到服务端。minutes<=0 表示解除。
     失败必须回滚本地 —— 否则界面显示已禁言、服务端没有。 */
  function syncMute(u, minutes) {
    if (!g.Online || !g.Online.isOnline()) return;
    g.Online.setMute(u.id, minutes).catch(function (e) {
      u.mutedUntil = minutes > 0 ? 0 : now() + 600000;
      save(true); renderAll();
      g.UI.toast('禁言同步失败：' + ((e && e.message) || '网络错误'), 'err');
    });
  }

  function permEditor(u) {
    if (u.role === 'owner') { g.UI.toast('站长拥有全部权限，无需单独设置'); return; }
    if (!g.ACL.can(me, 'user.perms')) { g.UI.toast('你没有分配权限的权限', 'err'); return; }

    var d = elc('div', 'perm-editor');
    var head = elc('div', 'form-tip');
    head.innerHTML = '为「<b>' + g.UI.esc(u.nick) + '</b>」单独设置权限（角色：' +
      g.UI.esc(g.ACL.roleName(u)) + '）。<br>' +
      '<b>继承</b>=按角色默认走；<b>允许</b>=单独给他；<b>禁止</b>=单独收回（优先级最高）。<br>' +
      '同为管理员，各人手里实际能做什么由这里的勾选决定。';
    d.appendChild(head);

    /* 角色模板快捷套用 */
    var tpl = elc('div', 'perm-tpl');
    tpl.innerHTML =
      '<span class="tpl-label">快捷套用：</span>' +
      '<button class="btn ghost sm" data-tpl="admin">管理员模板</button> ' +
      '<button class="btn ghost sm" data-tpl="member">普通成员模板</button> ' +
      '<button class="btn ghost sm" data-tpl="clear">全部恢复继承</button>';
    d.appendChild(tpl);

    var sels = [];
    g.ACL.groups().forEach(function (grp) {
      var sec = elc('div', 'perm-sec');
      sec.appendChild(elc('div', 'perm-sec-title', grp.name));
      grp.perms.forEach(function (p) {
        var row = elc('div', 'perm-row');
        var name = elc('div', 'perm-name');
        name.innerHTML = g.UI.esc(p[1]) + '<span class="perm-code">' + g.UI.esc(p[0]) + '</span>';
        var sel = document.createElement('select');
        sel.className = 'field sm perm-sel';
        sel.innerHTML =
          '<option value="inherit">继承</option>' +
          '<option value="allow">允许</option>' +
          '<option value="deny">禁止</option>';
        sel.value = g.ACL.stateOf(u, p[0]);
        sel.dataset.p = p[0];
        sels.push(sel);
        row.appendChild(name);
        row.appendChild(sel);
        sec.appendChild(row);
      });
      d.appendChild(sec);
    });

    /* 快捷套用 */
    Array.prototype.forEach.call(tpl.querySelectorAll('[data-tpl]'), function (btn) {
      btn.onclick = function () {
        var mode = btn.getAttribute('data-tpl');
        sels.forEach(function (sel) {
          var p = sel.dataset.p;
          if (mode === 'clear') { sel.value = 'inherit'; return; }
          var tplSet = (g.ACL.ROLE_PERMS[mode] || []);
          var inRole = (g.ACL.ROLE_PERMS[u.role] || []).indexOf(p) >= 0;
          /* 模板里有而角色默认没有 → 允许；模板里没有而角色默认有 → 禁止 */
          if (tplSet.indexOf(p) >= 0 && !inRole) sel.value = 'allow';
          else if (tplSet.indexOf(p) < 0 && inRole) sel.value = 'deny';
          else sel.value = 'inherit';
        });
      };
    });

    g.UI.modal({
      title: '权限分配 · ' + u.nick, body: d, wide: true, okText: '保存',
      onOk: function (body) {
        var allow = [], deny = [];
        sels.forEach(function (sel) {
          var v = sel.value, p = sel.dataset.p;
          if (v === 'allow') allow.push(p);
          else if (v === 'deny') deny.push(p);
        });
        u.perms = allow;
        u.denied = deny;
        touch(u);
        log('perm', u.nick + ' 权限：允许[' + allow.join(',') + '] 禁止[' + deny.join(',') + ']');
        save();
        g.UI.toast('已保存：允许 ' + allow.length + ' 项，禁止 ' + deny.length + ' 项', 'ok');
        /* 在线模式：denied 也必须一起存，否则服务端只知道「允许」，
           被禁止的权限在服务端照样放行。 */
        if (g.Online && g.Online.isOnline()) {
          g.Online.setPerms(u.id, allow, deny).catch(function (e) {
            g.UI.toast('权限同步失败：' + ((e && e.message) || '网络错误'), 'err');
          });
        }
      }
    });
  }

  function openProfile() {
    var d = elc('div', '');
    d.innerHTML =
      '<label class="field-label">昵称</label><input class="field" id="pNick" value="' + g.UI.esc(me.nick) + '">' +
      '<label class="field-label">申请说明</label><textarea class="field" id="pNote" rows="3">' + g.UI.esc(me.note || '') + '</textarea>' +
      '<label class="field-label">自定义头像</label>' +
      '<div class="avatar-edit"><div id="pAvPrev" class="avatar-prev"></div>' +
      '<div><button class="btn ghost" id="pAvPick" type="button">上传图片</button> ' +
      '<button class="btn ghost" id="pAvClear" type="button">恢复默认</button>' +
      '<input type="file" id="pAvFile" accept="image/*" class="hidden">' +
      '<div class="field-hint">图片会自动压缩为正方形小图，存在本地。</div></div></div>' +
      '<label class="field-label">个性签名</label><input class="field" id="pBio" value="' + g.UI.esc(me.bio || '') + '">' +
      '<label class="field-label">修改登录密码（留空不改）</label><input class="field" id="pPwd" type="password">' +
      '<div class="field-hint">默认头像由昵称首字母自动生成，配色取自昵称哈希；上传后改为自定义图片。</div>';

    /* 预览与选择头像 */
    var pickedAvatar = null;      // 本次选中的 dataURL（null=不改，''=恢复默认）
    (function () {
      var prev = d.querySelector('#pAvPrev');
      var draw = function (url) {
        prev.innerHTML = '';
        if (url) { prev.style.backgroundImage = 'url(' + url + ')'; prev.style.backgroundSize = 'cover'; }
        else { prev.style.backgroundImage = ''; g.UI.avatar(me, 'lg'); }
      };
      var showNow = function () {
        if (me.avatarId && g.Media) {
          g.Media.get(me.avatarId).then(function (u) { draw(u || null); }).catch(function () { draw(null); });
        } else draw(null);
      };
      showNow();
      d.querySelector('#pAvPick').onclick = function () { d.querySelector('#pAvFile').click(); };
      d.querySelector('#pAvClear').onclick = function () { pickedAvatar = ''; draw(null); };
      d.querySelector('#pAvFile').onchange = function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        g.Media.readFile(f).then(function (u) {
          return g.Media.compressImage(u, 240, 0.85);   // 压缩成小图，显示时按正方形裁切
        }).then(function (u2) {
          pickedAvatar = u2; draw(u2);
        }).catch(function () { g.UI.toast('图片处理失败', 'err'); });
      };
    })();

    g.UI.modal({
      title: '我的资料', body: d, okText: '保存', onOk: function (body) {
        var n = body.querySelector('#pNick').value.trim();
        if (!n) { g.UI.toast('昵称不能为空'); return false; }
        var dup = byNick(n);
        if (dup && dup.id !== me.id) { g.UI.toast('昵称已被占用'); return false; }
        me.nick = n;
        me.note = body.querySelector('#pNote').value.trim();
        me.bio = body.querySelector('#pBio').value.trim();
        var p = body.querySelector('#pPwd').value;
        if (p) {
          if (p.length < 4) { g.UI.toast('密码至少 4 位'); return false; }
          var s = g.SHA256.randomId(12);
          me.pwdSalt = s; me.pwdHash = hashPwd(p, s);
        }
        /* 保存头像 */
        if (pickedAvatar === '') {
          if (me.avatarId && g.Media.del) g.Media.del(me.avatarId);
          me.avatarId = null;
          if (g.UI.setAvatarCache) g.UI.setAvatarCache(me.id, null);
        } else if (pickedAvatar) {
          var aid = 'av_' + uid('x');
          g.Media.put(aid, pickedAvatar).then(function () {
            me.avatarId = aid; touch(me); save();
          });
          me.avatarId = aid;
          if (g.UI.setAvatarCache) g.UI.setAvatarCache(me.id, pickedAvatar);
        }
        touch(me); log('profile', me.nick); save();
      }
    });
  }

  /* ================= 管理面板 ================= */
  /* 站长 / 管理员手动开户（用于关闭公开注册、只放熟人进来的场景） */
  function newUserDialog() {
    var d = elc('div', '');
    d.innerHTML =
      '<div class="form-tip">手动开户后该账号可立即登录。请确认已线下核实对方真实身份。</div>' +
      '<label class="field-label">昵称（登录用）</label><input class="field" id="nuNick" placeholder="例如：小明">' +
      '<label class="field-label">备注（选填，仅站长可见）</label><input class="field" id="nuReal" placeholder="例如：李明，高二3班">' +
      '<label class="field-label">初始密码</label><input class="field" id="nuPwd" type="password" placeholder="至少 4 位，可告知对方自行修改">' +
      '<label class="field-label">角色</label><select class="field" id="nuRole">' +
      '<option value="member">成员</option><option value="admin">管理员</option>' +
      (me.role === 'owner' ? '<option value="owner">站长（会把站长转让给 TA）</option>' : '') +
      '</select>';
    g.UI.modal({
      title: '手动开户', body: d, okText: '创建', onOk: function (body) {
        var n = body.querySelector('#nuNick').value.trim();
        var r = body.querySelector('#nuReal').value.trim();
        var p = body.querySelector('#nuPwd').value;
        var role = body.querySelector('#nuRole').value;
        if (!n) { g.UI.toast('请填写昵称'); return false; }
        if (p.length < 4) { g.UI.toast('初始密码至少 4 位'); return false; }
        if (byNick(n)) { g.UI.toast('昵称已被占用'); return false; }
        var salt = g.SHA256.randomId(12);
        var u = {
          id: uid('u'), nick: n, note: r || '站长开户', status: 'active', pwdHash: hashPwd(p, salt), pwdSalt: salt,
          role: role === 'owner' ? 'owner' : role, perms: [], banned: false,
          mutedUntil: 0, bio: '', createdAt: now(), updatedAt: now(), lastSeen: now()
        };
        if (role === 'owner' && me.role === 'owner') { me.role = 'admin'; touch(me); }
        S.users.push(u);
        joinRoom('public', u, true);
        log('newuser', '手动开户 ' + n + (r ? '（' + r + '）' : ''));
        save();
        g.UI.toast('已开户：' + n, 'ok');
      }
    });
  }

  function adminPanel() {
    if (!g.ACL.can(me, 'audit.log') && !g.ACL.can(me, 'user.view')) { g.UI.toast('仅管理员可打开管理面板', 'err'); return; }
    /* 在线模式下先拉一次再渲染：否则新注册的账号要等下一次轮询才出现在审核列表里，
       站长会以为"注册了但看不到申请"。 */
    if (g.Online && g.Online.isOnline()) {
      g.Online.pull().then(function (inS) {
        if (inS && mergeState(inS)) { save(true); renderAll(); }
        adminPanelRender();
      }).catch(function () { adminPanelRender(); });
      return;
    }
    adminPanelRender();
  }

  function adminPanelRender() {
    if (!g.ACL.can(me, 'audit.log') && !g.ACL.can(me, 'user.view')) { g.UI.toast('仅管理员可打开管理面板', 'err'); return; }
    var d = elc('div', '');
    d.innerHTML =
      '<div class="tabs">' +
      '<button class="tab on" data-t="users">用户</button>' +
      '<button class="tab" data-t="audit">审核</button>' +
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
        /* 手动开户：关闭公开注册后，站长/管理员可线下核实身份再开号 */
        if (g.ACL.can(me, 'user.create')) {
          var ubar = elc('div', 'chip-box');
          var addBtn = elc('button', 'btn primary', '＋ 手动开户');
          addBtn.onclick = function () { newUserDialog(); };
          ubar.appendChild(addBtn);
          var utip = elc('div', 'field-hint',
            '关闭公开注册后，新人只能由你在开户。开户前请先线下核实对方真实身份。');
          b.appendChild(ubar);
          b.appendChild(utip);
        }
        S.users.slice().sort(function (x, y) { return (y.lastSeen || 0) - (x.lastSeen || 0); }).forEach(function (u) {
          var line = elc('div', 'user-line');
          line.appendChild(g.UI.avatar(u, 'sm'));
          var main = elc('div', 'user-line-main');
          main.innerHTML = '<div class="user-line-name">' + g.UI.esc(u.nick) +
            (u.status === 'pending' ? ' <span class="tag orange">待审核</span>' : '') + '</div>' +
            '<div class="user-line-role">' + g.ACL.roleName(u) + ' · ' + g.UI.fmtTime(u.lastSeen || u.createdAt) +
            (u.note ? ' · ' + g.UI.esc(u.note.slice(0, 30)) : '') + '</div>';
          line.appendChild(main);
          if (u.banned) line.appendChild(elc('span', 'tag red', '封禁'));
          if (g.ACL.muted(u)) line.appendChild(elc('span', 'tag orange', '禁言'));
          var ops = elc('div', 'line-ops');
          /* 对自己不显示任何管理操作。
             服务端已经拦（self_guard），但按钮摆在那里就是诱导误点 ——
             站长把自己封禁后失去全部权限，连解封都点不了。 */
          var isSelf = !!(me && u && me.id === u.id);
          ops.appendChild(mkBtn('资料', function () { mo.close(); userCard(u, findRoom(cur)); }));
          if (isSelf) {
            ops.appendChild(elc('span', 'tag', '本人'));
          }
          if (!isSelf && g.ACL.can(me, 'user.ban')) ops.appendChild(mkBtn(u.banned ? '解封' : '封禁', function () { u.banned = !u.banned; touch(u); log(u.banned ? 'ban' : 'unban', u.nick); save(); adminPanelRefresh(mo, d, view, t); }));
          if (!isSelf && g.ACL.can(me, 'user.mute')) ops.appendChild(mkBtn(g.ACL.muted(u) ? '解禁' : '禁言', function () {
            if (g.ACL.muted(u)) { u.mutedUntil = 0; touch(u); save(); syncMute(u, 0); }
            else g.UI.prompt('禁言分钟数', '', '10', function (v) { u.mutedUntil = now() + (parseInt(v, 10) || 10) * 60000; touch(u); log('mute', u.nick); save(); });
            adminPanelRefresh(mo, d, view, t);
          }));
          if (!isSelf && me.role === 'owner') ops.appendChild(mkBtn(u.role === 'admin' ? '撤管理' : '设管理', function () { u.role = u.role === 'admin' ? 'member' : 'admin'; touch(u); log('role', u.nick + '→' + u.role); save(); adminPanelRefresh(mo, d, view, t); }));
          if (!isSelf && me.role === 'owner') ops.appendChild(mkBtn('权限', function () { mo.close(); permEditor(u); }));
          if (!isSelf && me.role === 'owner') ops.appendChild(mkBtn('删除', function () {
            g.UI.confirm('删除用户「' + u.nick + '」？其消息将保留。', function () {
              S.users = S.users.filter(function (x) { return x.id !== u.id; });
              log('deluser', u.nick); save(); adminPanelRefresh(mo, d, view, t);
            });
          }));
          if (!isSelf) ops.appendChild(mkBtn('拒绝', function () {
            var rd = elc('div', '');
            rd.innerHTML =
              '<label class="field-label">拒绝理由（展示给对方）</label><input class="field" id="rjWhy" placeholder="选填">' +
              '<label class="field-label">处理方式</label><select class="field" id="rjMode">' +
              '<option value="delete">删除申请（对方可重新提交）</option>' +
              '<option value="reject">保留为已拒绝（不再出现在待审核）</option></select>';
            g.UI.modal({
              title: '拒绝「' + g.UI.esc(u.nick) + '」的申请', body: rd, okText: '确认拒绝', danger: true,
              onOk: function (body) {
                var why = (body.querySelector('#rjWhy').value || '').trim();
                var mode = body.querySelector('#rjMode').value;
                if (mode === 'reject') {
                  u.status = 'rejected';
                  u.rejectReason = why || '未说明理由';
                  touch(u);
                }
                log('audit', '拒绝 ' + u.nick + (why ? '：' + why : ''));
                if (mode === 'delete') {
                  S.users = S.users.filter(function (x) { return x.id !== u.id; });
                  if (g.Online && g.Online.isOnline()) {
                    g.SB.rpc('user_delete', { p_user: u.id }).catch(function () {
                      g.UI.toast('服务端删除失败（本地已删除）', 'err');
                    });
                  }
                } else {
                  if (g.Online && g.Online.isOnline()) {
                    g.SB.rpc('user_review', { p_user: u.id, p_status: 'banned' }).catch(function () { });
                  }
                }
                save(); adminPanelRefresh(mo, d, view, t);
                g.UI.toast('已拒绝', 'ok');
              }
            });
          }));
          line.appendChild(ops);
          b.appendChild(line);
        });
      } else if (t === 'audit') {
        /* 注册申请审核：站长/管理员看申请说明，决定通过或拒绝 */
        var pend = S.users.filter(function (u) { return u.status === 'pending'; });
        if (!pend.length) b.appendChild(elc('div', 'empty-tip', '暂无待审核申请'));
        pend.forEach(function (u) {
          var line = elc('div', 'audit-item');
          line.appendChild(g.UI.avatar(u, 'sm'));
          var main = elc('div', 'user-line-main');
          main.innerHTML = '<div class="user-line-name">' + g.UI.esc(u.nick) + '</div>' +
            '<div class="audit-note">“' + g.UI.esc(u.note || '（未填写说明）') + '”</div>' +
            '<div class="user-line-role">申请时间：' + g.UI.fmtFull(u.createdAt) + '</div>';
          line.appendChild(main);
          var ops = elc('div', 'line-ops');
          ops.appendChild(mkBtn('通过', function () {
            u.status = 'active'; touch(u);
            joinRoom('public', u, true);
            sysMsg('public', '「' + u.nick + '」通过了审核，加入聊天室');
            log('audit', '通过 ' + u.nick);
            save(); adminPanelRefresh(mo, d, view, t);
            /* 审核是站长的核心动作，必须落到服务端 ——
               否则在本地通过了，对方换个设备仍是待审核。 */
            if (g.Online && g.Online.isOnline()) {
              g.SB.rpc('user_review', { p_user: u.id, p_status: 'active' })
                .then(function () {
                  if (g.Online.addMember) g.Online.addMember('public', u.id).catch(function () { });
                })
                .catch(function (e) {
                  g.UI.toast('已通过本地审核，但服务端同步失败：' + ((e && e.message) || '网络错误'), 'err');
                });
            }
          }));
          ops.appendChild(mkBtn('拒绝', function () {
            var rd = elc('div', '');
            rd.innerHTML =
              '<div class="form-tip">拒绝理由会保留在此人的重新申请记录里；' +
              '若你选择「删除申请」，对方可用同一昵称重新提交。</div>' +
              '<label class="field-label">拒绝理由（选填，会记入日志）</label>' +
              '<input class="field" id="rjWhy" placeholder="例如：看不出是我们班的同学，请补充说明">' +
              '<label class="field-label">处理方式</label><select class="field" id="rjMode">' +
              '<option value="delete">删除申请（对方可重新提交）</option>' +
              '<option value="reject">保留为已拒绝（不再出现在待审核）</option></select>';
            g.UI.modal({
              title: '拒绝「' + g.UI.esc(u.nick) + '」的申请', body: rd, okText: '确认拒绝', danger: true,
              onOk: function (body) {
                var why = (body.querySelector('#rjWhy').value || '').trim();
                var mode = body.querySelector('#rjMode').value;
                if (mode === 'reject') {
                  u.status = 'rejected';
                  u.rejectReason = why || '未说明理由';
                  touch(u);
                }
                log('audit', '拒绝 ' + u.nick + (why ? '：' + why : ''));
                if (mode === 'delete') {
                  S.users = S.users.filter(function (x) { return x.id !== u.id; });
                  if (g.Online && g.Online.isOnline()) {
                    g.SB.rpc('user_delete', { p_user: u.id }).catch(function () {
                      g.UI.toast('服务端删除失败（本地已删除）', 'err');
                    });
                  }
                } else {
                  if (g.Online && g.Online.isOnline()) {
                    g.SB.rpc('user_review', { p_user: u.id, p_status: 'banned' }).catch(function () { });
                  }
                }
                save(); adminPanelRefresh(mo, d, view, t);
                g.UI.toast('已拒绝', 'ok');
              }
            });
          }));
          line.appendChild(ops);
          b.appendChild(line);
        });
        b.appendChild(elc('div', 'field-hint',
          '通过：对方即可用注册时填的密码登录；拒绝：删除该申请，对方可用同一昵称重新申请。' +
          '若想完全不让陌生人注册，请到「站点」页签关闭开放注册。'));
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
        /* 权限矩阵：用户 × 权限，逐项可点，站长行锁定 */
        var tip = elc('div', 'form-tip');
        tip.innerHTML = '点某个成员可逐项分配权限。<b>管理员只是称号</b>，' +
          '实际能做什么由这里的勾选决定。<br>站长恒为全部权限，不可剥夺。';
        b.appendChild(tip);

        var canGrant = g.ACL.can(me, 'user.perms');
        var list = S.users.slice().sort(function (x, y) {
          var oa = { owner: 0, admin: 1, member: 2 };
          return (oa[x.role] == null ? 9 : oa[x.role]) - (oa[y.role] == null ? 9 : oa[y.role]);
        });
        list.forEach(function (u) {
          var line = elc('div', 'user-line');
          line.appendChild(g.UI.avatar(u, 'sm'));
          var main = elc('div', 'user-line-main');
          var cc = g.ACL.customCount(u);
          var allowN = (u.perms || []).length, denyN = (u.denied || []).length;
          main.innerHTML = '<div class="user-line-name">' + g.UI.esc(u.nick) +
            ' <span class="tag ' + (u.role === 'owner' ? 'red' : u.role === 'admin' ? 'orange' : 'gray') + '">' +
            g.UI.esc(g.ACL.roleName(u)) + '</span></div>' +
            '<div class="user-line-role">' +
            (u.role === 'owner' ? '全部权限（不可剥夺）' :
              (cc ? '自定义 ' + cc + ' 项：允许 ' + allowN + ' · 禁止 ' + denyN : '按角色默认继承')) +
            '</div>';
          line.appendChild(main);
          if (u.role === 'owner') {
            line.appendChild(elc('span', 'tag gray', '全部权限'));
          } else if (canGrant) {
            line.appendChild(mkBtn('分配权限', function () { mo.close(); permEditor(u); }));
          }
          b.appendChild(line);
        });

        /* 角色默认对照表（只读，用于说明"继承"是什么） */
        b.appendChild(elc('div', 'sec-title', '角色默认权限（继承时按此判定）'));
        var wrap = elc('div', 'perm-table-wrap');
        var html = '<table class="md-table"><thead><tr><th>权限</th><th>站长</th><th>管理员</th><th>成员</th></tr></thead><tbody>';
        g.ACL.all().forEach(function (p) {
          html += '<tr><td>' + g.UI.esc(g.ACL.label(p)) + ' <code>' + p + '</code></td>' +
            '<td>✓</td>' +
            '<td>' + (g.ACL.ROLE_PERMS.admin.indexOf(p) >= 0 ? '✓' : '—') + '</td>' +
            '<td>' + (g.ACL.ROLE_PERMS.member.indexOf(p) >= 0 ? '✓' : '—') + '</td></tr>';
        });
        html += '</tbody></table>';
        wrap.innerHTML = html;
        b.appendChild(wrap);
      } else if (t === 'logs') {
        /* 筛选条：按人、按类型、按关键词 */
        var fbox = elc('div', 'log-filter');
        var acts = [];
        S.logs.forEach(function (x) { if (x.act && acts.indexOf(x.act) < 0) acts.push(x.act); });
        fbox.innerHTML =
          '<select class="field sm" id="lgWho"><option value="">全部人</option>' +
          S.users.map(function (u) { return '<option value="' + u.id + '">' + g.UI.esc(u.nick) + '</option>'; }).join('') +
          '</select>' +
          '<select class="field sm" id="lgAct"><option value="">全部操作</option>' +
          acts.map(function (a) { return '<option value="' + g.UI.esc(a) + '">' + g.UI.esc(a) + '</option>'; }).join('') +
          '</select>' +
          '<input class="field sm" id="lgKw" placeholder="关键词">' +
          '<button class="btn ghost sm" id="lgGo">筛选</button> ' +
          '<button class="btn ghost sm" id="lgAll">重置</button>';
        b.appendChild(fbox);

        var l = elc('div', 'log-list');
        var drawLogs = function () {
          l.innerHTML = '';
          var w = fbox.querySelector('#lgWho').value;
          var a = fbox.querySelector('#lgAct').value;
          var k = (fbox.querySelector('#lgKw').value || '').trim().toLowerCase();
          var arr = S.logs.filter(function (x) {
            if (w && x.who !== w) return false;
            if (a && x.act !== a) return false;
            if (k && ((x.detail || '') + (x.act || '')).toLowerCase().indexOf(k) < 0) return false;
            return true;
          });
          if (!arr.length) l.appendChild(elc('div', 'empty-tip', '没有符合条件的记录'));
          arr.slice(0, 200).forEach(function (x) {
            var who = findUser(x.who);
            var row = elc('div', 'log-row');
            row.innerHTML = '<span class="log-t">' + g.UI.fmtFull(x.ts) + '</span>' +
              '<span class="log-w">' + g.UI.esc(who ? who.nick : '系统') + '</span>' +
              '<span class="log-a">' + g.UI.esc(x.act) + '</span>' +
              '<span class="log-d">' + g.UI.esc(x.detail || '') + '</span>';
            l.appendChild(row);
          });
          var cnt = elc('div', 'field-hint', '共 ' + arr.length + ' 条' + (arr.length > 200 ? '（仅显示最新 200 条）' : ''));
          l.appendChild(cnt);
        };
        fbox.querySelector('#lgGo').onclick = drawLogs;
        fbox.querySelector('#lgAll').onclick = function () {
          fbox.querySelector('#lgWho').value = '';
          fbox.querySelector('#lgAct').value = '';
          fbox.querySelector('#lgKw').value = '';
          drawLogs();
        };
        drawLogs();
        b.appendChild(l);
      } else {
        var sd = elc('div', '');
        sd.innerHTML =
          '<label class="field-label">站点名称</label><input class="field" id="stName" value="' + g.UI.esc(S.siteName || '') + '">' +
          '<label class="field-label">保护密码（留空不改）</label><input class="field" id="stGate" type="password" placeholder="进入本聊天室所需密码">' +
          '<label class="field-label">开放注册</label><select class="field" id="stReg">' +
          '<option value="1"' + (S.allowRegister ? ' selected' : '') + '>允许任何人注册</option>' +
          '<option value="0"' + (!S.allowRegister ? ' selected' : '') + '>关闭公开注册</option></select>' +
          '<label class="field-label">外观</label><select class="field" id="stTheme">' +
          '<option value="auto">跟随系统</option>' +
          '<option value="light">浅色</option>' +
          '<option value="dark">深色</option></select>' +
          '<div class="field-hint">深色模式会记住你的选择，每个访客可各自设置，不影响其他人。</div>' +
          '<label class="field-label">发送键</label><select class="field" id="stEnter">' +
          '<option value="send">Enter 发送 / Shift+Enter 换行</option>' +
          '<option value="newline">Enter 换行 / Ctrl+Enter 发送</option></select>' +
          '<label class="field-label">注册审核</label><select class="field" id="stReview">' +
          '<option value="1"' + (S.needReview !== false ? ' selected' : '') + '>需站长审核通过后才能登录</option>' +
          '<option value="0"' + (S.needReview === false ? ' selected' : '') + '>注册后直接可用（免审核）</option></select>' +
          (function () {
            var th = 'auto', en = 'send';
            try { th = localStorage.getItem(THEME_KEY) || 'auto'; en = localStorage.getItem(ENTER_KEY) || 'send'; } catch (e) { }
            setTimeout(function () {
              var a = sd.querySelector('#stTheme'), b2 = sd.querySelector('#stEnter');
              if (a) a.value = th;
              if (b2) b2.value = en;
            }, 0);
            return '';
          })() +
          '<div class="field-hint">数据全部保存在本机浏览器（localStorage + IndexedDB），不上传任何服务器。' +
          '需要换设备或备份时，用下面的「导出 / 导入 JSON」搬运，本地版与上线版操作完全相同。</div>' +
          '<div class="sec-title">数据</div>' +
          '<button class="btn ghost" id="stExport">导出 JSON</button> ' +
          '<button class="btn ghost" id="stImport">导入 JSON</button> ' +
          '<button class="btn ghost" id="stEnv">运行环境</button> ' +
          '<button class="btn danger" id="stReset">重置站点</button> ' +
          '<button class="btn ghost" id="stExportChat">导出聊天记录</button> ' +
          '<button class="btn ghost" id="stClean">清理旧媒体</button> ' +
          '<button class="btn ghost" id="stUnhide">恢复已删除</button> ' +
          '<button class="btn ghost" id="stQuota">存储用量</button> ' +
          '<input type="file" id="stFile" accept="application/json" class="hidden">';
        b.appendChild(sd);
        sd.querySelector('#stExport').onclick = function () {
          var blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'chat-state-' + new Date().toISOString().slice(0, 10) + '.json';
          a.click();
          markBackup();
          g.UI.toast('已导出备份', 'ok');
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
        sd.querySelector('#stExportChat').onclick = function () { exportDialog(); };
        sd.querySelector('#stClean').onclick = function () { mediaCleanDialog(); };
        sd.querySelector('#stUnhide').onclick = function () {
          var c = hiddenCount();
          if (!c) { g.UI.toast('你没有删除过消息'); return; }
          g.UI.confirm('你删除了 ' + c + ' 条消息（仅你自己不可见）。要恢复显示吗？',
            function () { restoreHidden(); });
        };
        sd.querySelector('#stQuota').onclick = function () {
          var st = storageInfo();
          g.UI.modal({
            title: '存储用量', okText: '关闭', cancelText: null,
            body: (function () {
              var d2 = elc('div', 'env-grid');
              var kv = [['状态快照', st.stateKB + ' KB'], ['上限（约）', st.quotaKB + ' KB'],
                ['媒体文件数', st.mediaCount + ' 个'],
                ['使用率', Math.round(st.stateKB / st.quotaKB * 100) + '%']];
              d2.innerHTML = kv.map(function (x) {
                return '<div class="env-item"><div class="env-k">' + g.UI.esc(x[0]) +
                  '</div><div class="env-v">' + g.UI.esc(x[1]) + '</div></div>';
              }).join('');
              return d2;
            })()
          });
        };
        sd.querySelector('#stReset').onclick = function () {
          g.UI.confirm('将清空全部用户、房间与消息（媒体仍在 IndexedDB）。确定？', function () {
            S = fresh(); ensurePublic();
            var s = g.SHA256.randomId(12);
            me = {
              id: uid('u'), nick: '站长', note: '站长', status: 'active', pwdHash: hashPwd('admin', s), pwdSalt: s,
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
          S.needReview = sd.querySelector('#stReview').value === '1';
          setTheme(sd.querySelector('#stTheme').value);
          try { localStorage.setItem(ENTER_KEY, sd.querySelector('#stEnter').value); } catch (e) { }
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
      markTyping();
      /* Enter 行为按设置：默认 Enter 发送、Shift+Enter 换行；
         也可改为 Enter 换行、Ctrl+Enter 发送 */
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (enterSends()) { e.preventDefault(); send(); }
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    });
    ta.addEventListener('input', function () {
      ta.style.height = 'auto';
      ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
    });
    var ariaMap = { btnImg: '发送图片', btnVideo: '发送视频', btnFile: '发送文件附件',
                    btnVoice: '按住录制语音', btnEmoji: '表情面板', btnAt: '提及某人',
                    btnHelp: '语法帮助', btnTheme: '切换深色模式', btnMode: '切换极简或专业模式' };
    Object.keys(ariaMap).forEach(function (id) {
      var el = $(id);
      if (el && !el.getAttribute('aria-label')) {
        el.setAttribute('aria-label', ariaMap[id]);
        el.setAttribute('title', ariaMap[id]);
      }
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
    if ($('btnAt')) $('btnAt').onclick = toggleAtPanel;
    $('btnHelp').onclick = helpModal;
    $('btnNewRoom').onclick = function () { createRoom(''); };
    $('btnAdmin').onclick = adminPanel;
    $('btnLogout').onclick = function () {
      g.UI.confirm('退出登录？', function () {
        sessionStorage.removeItem(ME_KEY);
        me = null; cur = 'public';
        $('app').classList.add('hidden');
        $('app').style.display = 'none';
        loginView();
      });
    };
    var bm = $('btnMode');
    if (bm) bm.onclick = function () {
      setMode(getMode() === 'simple' ? 'pro' : 'simple');
    };
    /* 草稿：输入即记录 */
    var ta = $('input');
    if (ta) {
      ta.addEventListener('input', function () {
        drafts[cur] = ta.value;
        autoGrow(ta);
        typingAt = now();
      });
    }
    /* 语音：点一下开始，再点一下发送；或按住说话 */
    var bv = $('btnVoice');
    if (bv) {
      bv.onclick = function () {
        if (rec) { stopRecord(false); } else { startRecord(); }
      };
    }
    /* 取消录音的唯一出口。
       没有它，误触 🎙 之后只能：把不想发的语音发出去，或刷新页面。
       cancelRecord() 早就写好了，只是从没接到 UI 上。 */
    var rc = $('recCancel');
    if (rc) rc.onclick = function (e) {
      e.preventDefault(); e.stopPropagation();
      cancelRecord();
    };
    /* 文件附件 */
    var bf = $('btnFile');
    if (bf) bf.onclick = function () { $('fileDoc').click(); };
    var fd = $('fileDoc');
    if (fd) fd.onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) sendMediaFile(f, 'file');
      fd.value = '';
    };
    /* 多图连发 */
    var fi = $('fileImg');
    if (fi) fi.addEventListener('change', function (e) {
      var fs = Array.prototype.slice.call(e.target.files || []);
      fi.value = '';
      if (!fs.length) return;
      if (fs.length === 1) { sendMediaFile(fs[0], 'image'); return; }
      g.UI.confirm('发送这 ' + fs.length + ' 张图片？', function () {
        fs.forEach(function (f, i) { setTimeout(function () { sendMediaFile(f, 'image'); }, i * 350); });
      });
    });
    /* Markdown 工具条：插入语法 */
    Array.prototype.forEach.call(document.querySelectorAll('.md-btn[data-ins]'), function (b) {
      b.onclick = function () {
        var ta = $('input');
        if (!ta) return;
        var a = b.getAttribute('data-ins').replace(/\\n/g, '\n');
        var c = b.getAttribute('data-ins2').replace(/\\n/g, '\n');
        var st = ta.selectionStart || 0, en = ta.selectionEnd || 0;
        var sel = ta.value.slice(st, en);
        ta.value = ta.value.slice(0, st) + a + sel + c + ta.value.slice(en);
        ta.focus();
        var pos = st + a.length + sel.length;
        ta.setSelectionRange(pos, pos);
        drafts[cur] = ta.value;
      };
    });
    var sbtn = $('btnSearchMsg');
    if (sbtn) sbtn.onclick = function () { searchModal(); };
    /* 表情面板 */
    var be = $('btnEmoji');
    if (be) be.onclick = function () { emojiPanel(); };
    /* 公式符号面板（专业模式） */
    var bs = $('btnSym');
    if (bs) bs.onclick = function () { symbolPanel(); };
    $('btnMembers').onclick = function () {
      var p = $('sidePanel');
      p.classList.toggle('hidden');
    };
    $('btnRoomSet').onclick = function () { roomMenu(findRoom(cur)); };
    $('btnEditNotice').onclick = function () { editNotice(findRoom(cur)); };
    $('searchInput').addEventListener('input', function (e) { roomFilter = e.target.value; renderSidebar(); });
    /* 抽屉：原来只有 ☰ 能开合。手机上侧栏是覆盖式的，
       打开后没有遮罩、没有关闭按钮、点外面也没反应 —— 出不来。
       补三个出口：点遮罩、点侧栏外任意处、按 ESC。 */
    $('btnMenu').onclick = function () { toggleSidebar(); };
    document.addEventListener('click', function (e) {
      var sb = $('sidebar');
      if (!sb || !sb.classList.contains('show')) return;
      if (sb.contains(e.target)) return;
      if (e.target === $('btnMenu') || ($('btnMenu') && $('btnMenu').contains(e.target))) return;
      sb.classList.remove('show');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var sb = $('sidebar');
        if (sb) sb.classList.remove('show');
      }
    });
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

  /* @ 提及面板：列出本会话成员，点一下插入 @昵称；管理员另有 @全体成员 */
  function toggleAtPanel() {
    var r = findRoom(cur);
    var list = membersOf(r).filter(function (u) { return u.id !== me.id && u.status !== 'pending'; });
    var d = elc('div', '');
    var box = elc('div', 'chip-box');
    var canAll = (r.owner === me.id || (r.admins || []).indexOf(me.id) >= 0 ||
      me.role === 'owner' || me.role === 'admin');
    var mk = function (text, val) {
      var b = elc('button', 'btn ghost sm', text);
      b.onclick = function () { insertAtCursor(val); g.UI.closeModal && g.UI.closeModal(); closeTop(); };
      return b;
    };
    if (canAll && r.type !== 'private') box.appendChild(mk('@全体成员', '@全体成员 '));
    if (!list.length && !canAll) box.appendChild(elc('div', 'empty-tip', '本会话没有其他成员'));
    list.forEach(function (u) { box.appendChild(mk('@' + u.nick, '@' + u.nick + ' ')); });
    d.appendChild(box);
    d.appendChild(elc('div', 'field-hint',
      '被 @ 的人会在侧栏看到红色提醒；' + (canAll ? '管理员可用「@全体成员」通知所有人。' : '')));
    g.UI.modal({ title: '提及某人', body: d, okText: '关闭', cancelText: null });
  }

  function closeTop() {
    var ms = document.querySelectorAll('.modal-mask');
    for (var i = ms.length - 1; i >= 0; i--) { ms[i].remove(); break; }
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
  /* 在线模式：认证与数据走服务端；连不上或站点未初始化则退回本地模式。
     降级必须是静默的 —— 后端挂了不该让用户进不去聊天室。 */
  function bootOnline() {
    if (!g.Online) return Promise.resolve(false);
    return g.Online.init({
      onState: function (inS) { if (mergeState(inS)) renderAll(); },
      /* 后端不可用 → 明确告知，不再静默回零 */
      onMode: function (ok) {
        if (!ok) g.UI.toast('未连接云端，当前为本地模式：数据只存在这台设备', 'err');
      }
    })
      .then(function (ok) {
        if (!ok) return false;
        if (!g.Online.isOnline()) {
          /* 连得上但站点还没初始化 → 走服务端初始化流程 */
          if (!S) { S = fresh(); ensurePublic(); }
          setupGate();
          return true;      /* 已接管，不再走本地门禁 */
        }
        /* 站点已初始化：拉一次全量，再决定显示门禁还是直接进 */
        return g.Online.pull().then(function (inS) {
          if (inS && mergeState(inS)) save(true);
          if (g.SB && g.SB.token()) afterGate();   /* 已有会话 */
          else enterGate();
          return true;
        }).catch(function () { return false; });
      })
      .catch(function () { return false; });
  }

  function boot() {
    initTheme();
    S = load();
    if (!S) { S = fresh(); ensurePublic(); save(true); }
    initSync();
    bootOnline().then(function (handled) {
      if (handled) { g.Online.startPoll(); return; }   /* 在线模式已接管 */
      /* 后端不可用 → 纯本地模式，行为与改动前一致 */
      if (!S.gate) { setupGate(); return; }
      if (sessionStorage.getItem(GATE_KEY) !== '1') { enterGate(); return; }
      afterGate();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  g.APP = {
    state: function () { return S; },
    me: function () { return me; },
    openRoom: openRoom,
    render: function () { try { renderAll(); } catch (e) { } },
    debugReset: function () { localStorage.removeItem(KEY); location.reload(); }
  };
})(window);
