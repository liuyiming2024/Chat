/* ------------------------------------------------------------------
 * app.js —— 主逻辑
 *  门禁 → 登录/注册 → 会话 → 消息（文本/图片/视频/Markdown/LaTeX）
 *  → 房间（公屏 / 群聊 / 私聊）→ 权限与管理 → 命令 → 同步
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var KEY = 'wxlg_state_v1', ME_KEY = 'wxlg_me', GATE_KEY = 'wxlg_gate_ok';

  /* ============ 凭据：多端共用一份 cookie ============
   *
   * 原来放在 sessionStorage —— 它是按标签页隔离的，开个新标签页就要重新输
   * 一遍保护密码。改成 cookie 之后，同一浏览器的所有标签页共用同一份凭据，
   * 这才是"多端共用"。
   *
   * 两类凭据的有效期刻意做得不一样：
   *   门禁（gate）：短。切到后台立刻作废 —— 回到前台必须重新输保护密码。
   *   账号（me）  ：可选记住。勾了就长期有效，不勾关掉标签页就没了。
   */
  function ckSet(name, val, days) {
    try {
      var d = new Date();
      d.setTime(d.getTime() + (days || 1) * 86400000);
      document.cookie = name + '=' + encodeURIComponent(val) +
        ';path=/;expires=' + d.toUTCString() + ';SameSite=Lax;Secure';
    } catch (e) { }
  }
  function ckGet(name) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }
  function ckDel(name) {
    try { document.cookie = name + '=;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT'; } catch (e) { }
  }

  /* 门禁：默认只给 1 天；切后台时会被清掉 */
  function setGateOk() { ckSet(GATE_KEY, '1', 1); }
  function gateOk() { return ckGet(GATE_KEY) === '1'; }
  function clrGate() { ckDel(GATE_KEY); }

  /* 账号凭据：三档有效期，互相独立
   *
   *   记住（勾选）  → 30 天，关掉浏览器也在
   *   没记住        → 在线期间有效，离开后再留 30 分钟
   *
   * "没记住"不是"关掉标签就没了"——那太苛刻：切个后台回来就要重登。
   * 也不是永久——那跟记住没区别。取中间：只要页面还在活动就一直续期，
   * 真的离开一会儿（超过 IDLE_MIN）才失效。
   *
   * 注意：这跟门禁是两回事。门禁每次切到前台都要重输，账号不用。 */
  var REMEMBER_KEY = 'wxlg_remember';
  var IDLE_MIN = 30;            /* 非记住模式：离开后还能用多久 */
  var REMEMBER_DAYS = 30;

  function ckSetMin(name, val, minutes) {
    try {
      var d = new Date();
      d.setTime(d.getTime() + minutes * 60000);
      document.cookie = name + '=' + encodeURIComponent(val) +
        ';path=/;expires=' + d.toUTCString() + ';SameSite=Lax;Secure';
    } catch (e) { }
  }

  function setMeId(id, remember) {
    /* ⚠ 原来空 catch（S-060）：写失败完全静默。
       后果很隐蔽 —— 用户勾了"记住账号"，实际没记住，
       下次打开要重新登录，而他不知道为什么。
       **"设置没生效"和"设置生效了但被清掉"在用户看来一模一样，
       只有告知才能区分。** */
    try { localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0'); }
    catch (e) {
      try { g.UI.toast('无法保存"记住账号"设置，本次登录状态不会保留', 'err', 5000); } catch (e2) { }
    }
    if (remember) ckSet(ME_KEY, id, REMEMBER_DAYS);
    else ckSetMin(ME_KEY, id, IDLE_MIN);
  }
  function meId() { return ckGet(ME_KEY); }
  function clrMe() { ckDel(ME_KEY); }
  function rememberOn() {
    try { return localStorage.getItem(REMEMBER_KEY) === '1'; } catch (e) { return false; }
  }

  /* 续期：页面还在活动时把有效期往后推。
     记住模式不用续（本来就长期）；没记住的才需要靠它维持"在线即有效"。 */
  function tickMe() {
    if (rememberOn()) return;
    var id = ckGet(ME_KEY);
    if (id) ckSetMin(ME_KEY, id, IDLE_MIN);
  }

  var S = null, me = null, cur = 'public';
  /* atMe 原本根本没声明 —— 有人 @ 我时这行会抛 "atMe is not defined"，
     整个 noteIncoming 中断：未读数不累加、renderRooms 不执行、通知也不发。
     这正是"提醒看起来没反应"的根源之一。 */
  var unread = {}, atMe = {}, replyTo = null, roomFilter = '';
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
  /* 我还能不能看这个房间的消息（E-059）。
     判据：房间还在 + 我是成员（或公开房间 / 房主 / 管理员）。
     被移出房间后本地仍留着那段历史，不解散就不会删 ——
     于是能搜到自己早就不该看到的对话，还能点进去看。
     **本地留着缓存不等于还有权限看。** */
  function canSeeRoom(rid) {
    var r = findRoom(rid);
    if (!r || !me) return false;
    if (r.type === 'public') return true;
    if (r.ownerId === me.id) return true;
    if (g.ACL && g.ACL.can && g.ACL.can(me, 'site.manage')) return true;
    return (r.members || []).indexOf(me.id) >= 0;
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

  /* ⚠ 本地状态原来没有版本字段，也没有迁移逻辑（S-073）。
     没有版本号就无法判断"要不要迁移"，也无法安全地拒绝读不懂的结构。 */
  var STATE_VER = 2;
  var STATE_BACKUP_KEY = KEY + '_bak';

  function fresh() {
    return {
      version: STATE_VER, createdAt: now(), seq: 0, siteName: '聊天室',
      gate: null, allowRegister: true, needReview: true,
      users: [], rooms: [], messages: {}, logs: []
    };
  }
  /* ⚠ 本地状态原来没有版本字段，也没有迁移逻辑（S-073）。
     后果：将来往 S 里加字段时，老用户 localStorage 里的旧结构
     会被原样读入 —— 新代码读到没有那个字段的对象，
     轻则功能不对，重则 undefined 报错，而用户只会看到"打不开了"。
     没有版本号就无法判断"要不要迁移"，也无法安全地拒绝读不懂的结构。

     所以：① 存的时候带上 version；② 读的时候按版本处理；
           ③ 版本比代码新的（用户降级了）不能直接丢，先备份再提示。 */
  /* 备份原始状态串。**返回是否真的写成了**，让调用方能如实告知用户。
     原来所有调用点都是 `try{...}catch(e){}` 然后照样提示"已备份" ——
     存储满的时候这个提示是假的。 */
  function backupRaw(raw) {
    try {
      localStorage.setItem(STATE_BACKUP_KEY, raw);
      return localStorage.getItem(STATE_BACKUP_KEY) === raw;
    } catch (e) { return false; }
  }

  function load() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return null; }
    if (!raw) return null;
    var s;
    try { s = JSON.parse(raw); } catch (e) {
      /* 结构坏了。不能直接返回 null —— 那等于把用户数据全丢了。
         先备份原始字符串，让用户有机会找回来。
         ⚠ 但"备份成功"必须真的成功才能说"已备份"：
            localStorage 写不进去时（配额满、隐私模式）原来照样提示已备份，
            用户去找 STATE_BACKUP_KEY 却发现是空的 ——
            **在最需要兜底的那一刻给了假消息**，比不提示更糟。
            备份失败要如实说"没备份成功"，并提示先腾空间。 */
      g.UI.toast(backupRaw(raw)
        ? '本地数据已损坏，已备份原始数据（' + STATE_BACKUP_KEY + '）'
        : '本地数据已损坏，且备份也没写成（存储已满）。请先清理空间再刷新，否则数据会丢失。',
        'err', 10000);
      return null;
    }
    if (!s || typeof s !== 'object') return null;

    var v = s.version || 1;   /* 没有 version 字段的就是第 1 版 */
    if (v > STATE_VER) {
      /* 数据比代码新：通常是用户把客户端降级了。
         硬读会丢字段，直接丢掉更糟 —— 备份后提示。 */
      /* 同上：备份失败不能说"已备份" */
      var okB = backupRaw(raw);
      g.UI.toast(okB
        ? '本地数据来自更新版本，已备份。请升级到最新版再打开。'
        : '本地数据来自更新版本，但备份没写成（存储已满）。请升级到最新版，并先清理空间。',
        'err', 10000);
      return null;
    }
    if (v < STATE_VER) {
      /* 迁移前备份：迁移是不可逆的，留一份旧版可退回 */
      backupRaw(raw);
      s = migrate(s, v);
    }
    s.version = STATE_VER;
    return s;
  }

  /* 迁移：从 v 升到 STATE_VER。
     每次加字段都要在这里补一步 —— 否则老用户读到的是半个对象。
     只做"补默认值"，绝不删数据：迁移里丢数据是最难查的事故。 */
  function migrate(s, from) {
    var v = from;
    if (v < 2) {
      /* v1 → v2：v2 新增了媒体槽位路径与已读位置，
         老数据没有这些字段，补空值即可，不改动已有消息。 */
      if (typeof s.unread !== 'object') s.unread = s.unread || {};
      if (typeof s.atMe !== 'object') s.atMe = s.atMe || {};
      if (typeof s.drafts !== 'object') s.drafts = s.drafts || {};
      v = 2;
    }
    return s;
  }
  var pushTimer = null;
  function save(silent) {
    if (!S) return;
    S.seq = (S.seq || 0) + 1;
    /* 未读数、@我、草稿必须一起持久化（E-010 / E-011）。
       这三个是模块级变量，而 save() 只序列化 S ——
       关掉页面再打开，未读红点和「有人@我」全部清零，
       消息还在，但用户不知道哪几条是新的、哪几条 @ 了自己。
       @我 恰恰是最该被记住的：它是"有人专门找你"的信号。

       放在 save 里而不是另开一个 key：
       避免两份数据不一致（一个写成功一个失败）。 */
    S.unread = unread;
    S.atMe = atMe;
    S.drafts = drafts;
    /* 唯一写入路径：先落快照，再由统一同步层广播（不区分部署形态） */
    /* 返回是否真的写成了，让调用方能如实告知（导入等场景要用）。
       原来无返回值，调用方只能无条件提示成功。 */
    var wrote = true;
    try {
      localStorage.setItem(KEY, JSON.stringify(S));
      markSaveOk();
    } catch (e) {
      wrote = false;
      /* save() 是唯一的写入出口，失败同样要挂常驻标记（S-114）。
         不能只弹一次 toast —— 用户发消息时写盘失败，
         消息在界面上照常显示（内存里有），看着像发出去了，
         下次打开却没了。 */
      markSaveFailed(e2);
    }
    if (pushTimer) clearTimeout(pushTimer);
    /* ⚠ 原来这里广播**全量 S**（S-090）。
       `Sync.commit(S)` 会把整个状态对象 postMessage 出去 ——
       消息多时是几十 MB 的结构化克隆，**每保存一次就一次**。
       而 save() 是高频调用（输入防抖、心跳、发消息……），
       于是房间越用越大、越用越卡，卡顿的根源是广播本身。

       而且 sync.js 早就备好了轻量通道 `ping()`：
       只发一个 {t:'patch', at}，对方收到后**自己读快照再合并**
       （见下方 onPatch 回调）—— 效果一样，传输量差几个数量级。

       ⚠ 不能简单删掉广播：那样别的标签感知不到变化。
         必须用 ping 替代 commit，而不是去掉这一行。 */
    pushTimer = setTimeout(function () {
      if (g.Sync && g.Sync.ping) g.Sync.ping();
    }, 60);
    if (!silent) renderAll();
    return wrote;
  }

  function mergeArr(a, b) {
    var m = {}, i;
    for (i = 0; i < a.length; i++) m[a[i].id] = a[i];
    for (i = 0; i < b.length; i++) {
      var x = b[i], o = m[x.id];
      if (!o) { m[x.id] = x; continue; }
      /* ⚠ 判据必须优先用 rev，不能用 updatedAt（S-085）。
         updatedAt 在 users 上其实是 lastSeen（最后上线时间），
         在 rooms 上其实是 createdAt（**永远不变**）——
         两个都不是"资料版本"，拿它们比大小得出的结论是错的。

         rooms 那条尤其致命：createdAt 恒不变 →
         `x.updatedAt > o.updatedAt` 恒为 false →
         **房间合并分支从不执行**，服务端改的房间名/公告被整个丢弃。

         现在两边都有真正的 rev（服务端触发器写入，老行已回填）。 */
      var xr = (typeof x.rev === 'number') ? x.rev : null;
      var or = (typeof o.rev === 'number') ? o.rev : null;
      var newer;
      if (xr !== null && or !== null) {
        newer = xr > or;
      } else {
        /* ⚠ rev 缺失时**必须合并，不能退回 updatedAt 判据**。
           退回旧判据对 rooms 来说等于永远不合并 —— 那正是这个 bug 本身。
           用户和房间都是小体量数据，多合并一次的代价远小于丢一次更新：
           丢更新表现为"改了不生效"，多合并最多是界面重绘一下。 */
        newer = true;
      }
      if (newer) {
        /* ⚠ 服务端没给的字段不能拿 undefined 覆盖本地（E-086-NOTE）。
           原来这里整对象替换：服务端响应里缺哪个字段，
           本地那个字段就被清成 undefined。
           典型受害者是用户的「申请说明」—— 登录接口刻意不返回 real_name
           （避免实名信息外泄），于是每次同步都把用户自己写的说明清空，
           站长看到的永远是一片空白。
           通用规则：**值为 undefined 的键视为"未给出"，保留本地值**。 */
        var merged = {}, k;
        for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) merged[k] = o[k];
        for (k in x) {
          if (!Object.prototype.hasOwnProperty.call(x, k)) continue;
          if (x[k] === undefined) continue;   /* 服务端没给 → 保留本地 */
          merged[k] = x[k];
        }
        m[x.id] = merged;
      }
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
        if (!o) {
          map[x.id] = x; changed = true;
          /* ⚠ 必须在这里调 noteIncoming（E-101，考古找回）。
             它定义了、函数体也修好了（renderRooms → renderSidebar），
             但**全仓零处调用** —— 未读不累加、@我不累加、桌面通知不发、
             标题不闪烁，四件事全死，而界面看上去一切正常。

             这是"修了一半"的典型：有人改了函数内部的 bug，
             却没检查有没有人调它。 */
          noteIncoming(x);
        }
        /* S-081（考古找回）：原来只处理"新增"和"删除"，没有"内容变了"这一支。
           后果：A 编辑消息后，B 无论走增量还是全量拉取，看到的永远是旧内容 ——
           因为 map[x.id] 已经存在，直接跳过不更新。
           编辑是唯一一个"改了却不生效"的操作，比不提供更容易让人困惑。 */
        else if (x.text !== o.text || x.editedAt !== o.editedAt) {
          map[x.id] = x; changed = true;
        }
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
      /* 明确告知状态 key：storage 兜底通道只认这一个，
         不要把通知设置、离线队列等别的 wxlg_ key 当成状态来合并 */
      stateKey: KEY,
      onState: function (inS) {
        if (mergeState(inS)) renderAllSoon();
      },
      /* E-061：接住别人的"正在输入"广播 */
      onTyping: function (d) { onTypingBroadcast(d); },
      onPatch: function () {
        /* 别的标签改了数据：重读快照并合并 */
        try {
          var raw = localStorage.getItem(KEY);
          if (raw && mergeState(JSON.parse(raw))) renderAllSoon();
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
          setGateOk();
          if (r && r.uid) setMeId(r.uid, rememberOn());
          return g.Online.pull().then(function (inS) {
            if (inS && mergeState(inS)) save(true);
            /* 回到在线：先把离线期间攒的消息补发出去。
               时间戳由服务端给 —— 本机时钟可能不准，用它会导致乱序。 */
            if (g.Online.flushOutbox) {
              g.Online.flushOutbox().then(function (r) {
                var sent = (r && r.sent) || 0;
                var failed = (r && r.failed) || 0;
                if (sent > 0) {
                  g.UI.toast('已补发 ' + sent + ' 条离线消息', 'ok');
                  save(); renderChatSoon();
                }
                /* 失败必须说出来（S-044）。
                   静默的后果：那几条一直挂着"待发送"，
                   用户以为迟早会发出去，其实每次都在失败。 */
                if (failed > 0) {
                  g.UI.toast('还有 ' + failed + ' 条没发出去'
                    + (r.err ? '（' + r.err + '）' : ''), 'err');
                  save(); renderChatSoon();
                }
              });
            }
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
      setGateOk();
      setMeId(u.id, rememberOn());
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
        g.Online.gate(p).then(function (r) {
          setGateOk();
          /* 用旧密码进来的：服务端把新密码解出来给前端，
             必须当场展示并让用户记住 —— 这一次之后旧密码就作废了。 */
          if (r && r.show_new) { showNewGate(r.show_new); }
          return g.Online.pull();
        }).then(function (inS) {
          if (inS && mergeState(inS)) save(true);
          afterGate();
        }).catch(function (e) {
          /* 「密码错误」和「网络异常」原来是同一句话（S-010）。
             这两种失败用户该做的事完全不同：
               密码错误 → 重新输入
               网络异常 → 等一会儿 / 检查网络
             混成一句，用户会一直改密码，而问题根本不在密码上。 */
          var msg = (e && e.message) ? String(e.message) : '';
          var isNet = /网络|fetch|timeout|Failed|超时|500|502|503|504/i.test(msg)
            || !msg || msg === '网络错误';
          g.UI.toast(isNet
            ? '网络异常，未能验证保护密码，请稍后再试'
            : (msg || '保护密码错误'), 'err');
        });
        return;
      }
      var gv = verifyPwd(p, S.gate.salt, S.gate.hash);
      if (!gv.ok) { g.UI.toast('密码错误', 'err'); return; }
      if (gv.legacy) { S.gate.hash = hashPwd(p, S.gate.salt); save(); }
      setGateOk();
      afterGate();
    }
    card.querySelector('#gOk').onclick = ok;
    card.querySelector('#gP').onkeydown = function (e) { if (e.key === 'Enter') ok(); };
  }

  /* 把已登录身份交给本机桥接服务（仅桌面版/APP 有意义）。
     票据由服务端签发并绑定 uid —— 网页端造不出来，只能兑换到这个身份。
     失败完全静默：桥接是便利功能，不是登录的必经路径。 */
  function publishBridge(nick) {
    try {
      if (!g.ElectronBridge || !g.ElectronBridge.bridgePublish) return;
      if (!g.Online || !g.Online.isOnline || !g.Online.isOnline()) return;
      g.Online.bridgeTicket(g.Bridge && g.Bridge.origin ? g.Bridge.origin() : '').then(function (code) {
        g.ElectronBridge.bridgePublish(nick, code);
      }).catch(function () { });
    } catch (e) { }
  }

  /* 回到前台时门禁已失效：把应用盖上门禁层重新验证。
     直接复用 enterGate —— 验证通过会走 afterGate，
     账号凭据还在的话能直接回到界面，不用再输一遍账号密码。 */
  /* 新保护密码展示页。
     改密码后第一次用旧密码进来会走到这里：新密码必须让用户当场看到并记住，
     因为旧密码这一次之后就作废了 —— 不展示，等于把人锁在门外。 */
  function showNewGate(newPwd) {
    var d = elc('div', '');
    d.innerHTML =
      '<div class="form-tip">你用的是<b>旧的保护密码</b>，已进入。' +
      '这是旧密码最后一次可用 —— 之后只能用下面的新密码。</div>' +
      '<label class="field-label">新的保护密码</label>' +
      '<div class="newpwd-box"><code>' + g.UI.esc(newPwd) + '</code></div>' +
      '<label class="remember-row"><input type="checkbox" id="npOk"> 我已经记住这个密码</label>' +
      '<div class="form-note">建议现在就存进备忘录。忘了只能让管理员再改一次。</div>';
    g.UI.modal({
      title: '保护密码已更新', body: d, okText: '进入',
      onOk: function (body) {
        var c = body.querySelector('#npOk');
        if (c && !c.checked) { g.UI.toast('请先确认已记住新密码'); return false; }
      }
    });
  }

  function reenterGate() {
    if (!me) return;                 /* 还没登录，本来就在门禁/登录页 */
    var wrap = $('gate');
    if (!wrap) return;
    wrap.classList.remove('hidden');
    wrap.style.display = '';
    wrap.innerHTML = '';
    enterGate();
  }

  function afterGate() {
    var id = meId();
    if (id) { var u = findUser(id); if (u && !u.banned) { me = u; enterApp(); return; } }
    loginView();
  }

  /* ================= 登录 / 注册 ================= */
  /* 本机桥接入口：桌面版/APP 已登录时，给一个"直接进"的按钮。
     探测不到就什么都不显示 —— 没装客户端是常态，不是异常。 */
  function renderBridge(pane) {
    var box = pane && pane.querySelector('#bridgeBox');
    if (!box || !g.Bridge) return;
    g.Bridge.probe().then(function (r) {
      if (!r) return;                       // 没装 / 没登录 → 保持隐藏
      if (!box.isConnected) return;         // 页面已经切走了

      /* 措辞要点：
         · 不说"本机客户端"——那是内部术语，用户不知道指什么
         · 说清"已登录"与"还要输保护密码"的关系，否则像自相矛盾：
           一个是账号、一个是站点门禁，两回事 */
      box.innerHTML =
        '<div class="bridge-line"></div>' +
        '<div class="bridge-title">检测到这台电脑上已登录 ' + g.UI.esc(r.nick) + '</div>' +
        '<button class="btn primary block" id="bGo">直接以该身份进入</button>' +
        '<div class="bridge-note">账号免密。站点保护密码是另一道门，仍需单独输入。</div>';
      box.classList.remove('hidden');
      box.querySelector('#bGo').onclick = function () {
        if (usedBridgeCode === r.code) {
          g.UI.toast('这张票据已用过，请重新登录或用账号密码登录', 'err');
          return;
        }
        var btn = this;
        btn.disabled = true;
        btn.textContent = '正在进入…';
        g.Online.bridgeRedeem(r.code, g.Bridge && g.Bridge.origin ? g.Bridge.origin() : '').then(function (res) {
          if (!res || res.ok === false) throw new Error((res && res.err) || '票据无效');
          g.SB.setSession(res.token, null);
          __bridgeUid = res.uid;
          setMeId(res.uid, rememberOn());
          usedBridgeCode = r.code;   // 标记已用，防止重复提交
          return g.Online.pull();
        }).then(function (inS) {
          if (inS && mergeState(inS)) save(true);
          var u = S.users.filter(function (x) { return x.id === res_uid(); })[0];
          me = u || null;
          if (!me) { location.reload(); return; }
          setGateOk();
          enterApp();
        }).catch(function (e) {
          /* 票据已经用掉了（服务端兑换成功但后续失败也算），
             这里必须把按钮换掉并说清为什么 ——
             否则用户再点一次只会得到一句莫名其妙的"票据无效"。 */
          box.innerHTML =
            '<div class="bridge-line"></div>' +
            '<div class="bridge-note">本机票据已用过（每张只能用一次）。' +
            '请在客户端里重新登录一次，或直接用账号密码登录。</div>';
          g.UI.toast(e.message || '进入失败，请用账号密码登录', 'err');
        });
      };
    }).catch(function () { });
  }

  /* 兑换成功后 uid 的临时存放（回调链里要跨 then 用） */
  var __bridgeUid = null;
  function res_uid() { return __bridgeUid; }
  var usedBridgeCode = null;

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
          /* 账号可以记住；保护密码不记（它每次回前台都要重输）。
             这两个是两套凭据，混在一起就会变成"记住了却还是要输"的困惑。 */
          '<label class="remember-row"><input type="checkbox" id="lRemember"' + (rememberOn() ? ' checked' : '') +
          '> 记住账号（30 天内不用再输账号密码）</label>' +
          '<button class="btn primary block" id="lOk">登录</button>' +
          /* ⚠⚠ 这个容器原来不存在：renderBridge() 里写着
             var box = pane.querySelector('#bridgeBox'); if (!box) return;
             而全项目**没有任何地方创建过 bridgeBox**。

             后果：装了桌面版且已登录的用户，打开网页版时
             看不到那个"检测到这台电脑上已登录 XXX，直接以该身份进入"的按钮 ——
             只能手动输账号密码。bridge.js 的探测、票据兑换、
             服务端的 bridge_ticket_redeem 全都是好的，
             就是最后这个容器没人建。

             和 btnSearchMsg 是同一类：功能做完没接上入口，
             `if (!box) return` 让它静默失效，不报错也不崩溃。 */
          /* 类名必须是 bridge-box：CSS 里的 .bridge-box 提供上间距，
             .bridge-box.hidden 负责隐藏。只写 hidden 虽然也能藏住
             （全局 .hidden 带 !important），但排版会贴着上面的按钮。 */
          '<div id="bridgeBox" class="bridge-box hidden"></div>';
        var ok = function () {
          /* 在线模式：登录走服务端。本地根本没有 pwdHash（服务端从不返回）。
             这段必须放在本地校验之前 —— 服务端用户的 pwdHash 是空的，
             走本地分支必然判「密码错误」。 */
          if (g.Online && g.Online.isOnline()) {
            var ln = card.querySelector('#lNick').value.trim();
            var lp = card.querySelector('#lPwd').value;
            if (!ln || !lp) { g.UI.toast('请填写昵称与密码'); return; }
            g.Online.login(ln, lp).then(function (r) {
              var rem = !!(card.querySelector('#lRemember') && card.querySelector('#lRemember').checked);
              /* ⚠ 登录成功了，但**没有清零本地失败计数**。
                 后果很隐蔽：用户在断网降级时输错过几次（计数累积），
                 后来联网、在线登录成功 —— 计数仍在。
                 下次再断网降级，计数已接近上限，
                 **密码明明是对的却提示"尝试次数过多"**。

                 用户会以为是密码错了、或账号被封，
                 怎么也想不到是"上次输错的记录没清掉"。
                 而且这段只在降级路径上出现，正常联网怎么试都正常，
                 所以极难复现、极难定位。 */
              clearLocalLoginFail();
              setMeId(r.uid, rem);
              publishBridge(card.querySelector('#lNick').value.trim());
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
          /* ⚠ 原来分两种提示（S-069）："用户不存在" / "密码错误"。
             服务端做对了（统一返回"昵称或密码错误"防枚举），
             但本地模式把昵称是否存在直接说了出来 ——
             **换设备或断网降级时，这套保护归零**，
             任何人都能在登录框里枚举出站内有哪些昵称。

             所以本地也要统一措辞。安全强度不该取决于当前是否联网。 */
          var u = byNick(card.querySelector('#lNick').value);
          var lv = u ? verifyPwd(card.querySelector('#lPwd').value, u.pwdSalt, u.pwdHash) : null;
          if (!u || !lv.ok) {
            /* 顺带做本地失败计数：原来本地模式完全不限流，
               而服务端 8 次就锁 —— 降级路径反而比正常路径松。 */
            var lf = localLoginFail();
            if (lf >= LOCAL_LOGIN_MAX) {
              /* ⚠ 原来只说"请稍后再试"，不说多久。
                 窗口是 15 分钟，用户不知道 ——
                 他可能一分钟后再试、再被拒，反复几次后认定账号坏了。
                 **限流必须说清解除条件**，否则它就不是限流而是封号。 */
              g.UI.toast('尝试次数过多，请 15 分钟后再试（这是本机限制，防暴力破解）', 'err', 6000);
              return;
            }
            g.UI.toast('昵称或密码错误', 'err');
            return;
          }
          if (lv.legacy) { u.pwdHash = hashPwd(card.querySelector('#lPwd').value, u.pwdSalt); save(); }
          if (u.banned) { g.UI.toast('该账号已被封禁', 'err'); return; }
          if (u.status === 'pending') { g.UI.toast('申请已提交，请等待站长通过', 'err'); return; }
          if (u.status === 'rejected') {
            g.UI.toast('申请未通过：' + (u.rejectReason || '站长未说明理由'), 'err'); return;
          }
          clearLocalLoginFail();
          setMeId(u.id, typeof __rem !== 'undefined' ? __rem : rememberOn());
          publishBridge(u.nick);
          me = u; touch(me); me.lastSeen = now(); save(true);
          enterApp();
        };
        card.querySelector('#lOk').onclick = ok;
        /* 探测本机客户端。没装就是 null，面板保持隐藏，不打扰。 */
        if (g.Bridge && !g.Bridge.isApp()) renderBridge(p);
        card.querySelector('#lPwd').onkeydown = function (e) { if (e.key === 'Enter') ok(); };
      } else {
        if (!S.allowRegister) {
          p.innerHTML = '<div class="form-tip">当前关闭了公开注册，请联系管理员开通账号。</div>';
          return;
        }
        p.innerHTML =
          '<label class="field-label">昵称（登录用）</label><input class="field" id="rNick" placeholder="字母/数字/中文均可">' +
          (function () {
            /* ⚠⚠ 原来取的是 S.users 里**第一个** status='rejected' 的用户，
               完全不看是不是本人。

               在线模式下 S.users 是服务端下发的**全体用户**列表，
               所以这里显示的是**随便哪个被拒的人**的拒绝理由 ——
               而且明确写着"你上次提交的申请未通过"。

               两个后果叠加：
                 ① 隐私：A 打开注册页，看到 B 的申请被拒及站长写的理由。
                    那段理由常常包含真实姓名、班级这类信息。
                 ② 误导：A 根本没提交过申请，却被告知"你上次未通过"，
                    他会以为自己记错了，或者以为账号出了问题。

               正确做法：只认本机自己提交过的那一次。
               用 localStorage 记下本机提交时的昵称，只有对得上才显示。 */
            var mine = null;
            try {
              var rawJ = localStorage.getItem(MY_APPLY_KEY);
              var rec = rawJ ? JSON.parse(rawJ) : null;
              if (rec && rec.nick) {
                mine = S.users.filter(function (x) {
                  return x.nick === rec.nick && x.status === 'rejected';
                })[0];
              }
            } catch (e) { mine = null; }
            return mine ? '<div class="form-tip warn">你上次提交的申请（' + g.UI.esc(mine.nick)
              + '）未通过：' + g.UI.esc(mine.rejectReason || '站长未说明理由')
              + '。可修改说明后重新提交。</div>' : '';
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
          /* 与服务端同一套规则（S-100）。服务端仍会再判一次，
             这里只是别让用户填完才被拒。 */
          var nv = nickValid(n);
          if (!nv.ok) { g.UI.toast(nv.why, 'err'); return; }
          if (a.length < 4) { g.UI.toast('密码至少 4 位'); return; }
          if (a !== b) { g.UI.toast('两次密码不一致'); return; }
          /* 在线模式：注册交给服务端，密码只在服务端 bcrypt */
          if (g.Online && g.Online.isOnline()) {
            g.Online.register(n, a, note).then(function () {
              try { localStorage.setItem(MY_APPLY_KEY, JSON.stringify({ nick: n, at: Date.now() })); } catch (e2) { }
              g.UI.toast('申请已提交，请等待站长通过', 'ok');
              pane('login');
            }).catch(function (e) {
              /* 拿不到服务端原因时用中性文案，不要猜。
                 猜成"昵称可能已被占用"，而真实原因可能是
                 "不允许注册"/"待审核"/网络错误 —— 猜错会把人引向错误的动作
                 （他会一直换昵称，其实换一百个也没用）。 */
              g.UI.toast('注册失败：' + ((e && e.message) || '请稍后再试'), 'err');
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
          /* ⚠ 原来无条件提示"申请已提交"。
             save() 写不进去时（存储满、隐私模式），
             新账号只在内存里 —— 刷新就没了，
             而用户看到的是"申请已提交，请等待站长通过"。

             他会一直等站长通过，可站长那边根本看不到这条申请
             （本地模式下压根没服务端），
             或者在线模式下这条申请从未上传。
             **等一个永远不会来的结果**，是最糟的一种失败反馈。 */
          var okSave = save(true);
          try { localStorage.setItem(MY_APPLY_KEY, JSON.stringify({ nick: n, at: Date.now() })); } catch (e2) { }
          if (okSave === false) {
            g.UI.toast('申请没能保存（存储已满）。请先清理空间再提交，否则刷新后会丢失。', 'err', 8000);
            S.users.pop();   /* 撤回内存里的半截状态，避免界面与存储不一致 */
            return;
          }
          if (needReview) {
            g.UI.toast('申请已提交，请等待站长通过', 'ok');
            pane('login');
          } else {
            joinRoom('public', u, true);
            setMeId(u.id, typeof __rem !== 'undefined' ? __rem : rememberOn());
          publishBridge(u.nick);
            publishBridge(u.nick);
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
    renderDndTip();
    renderNotifyCta();
    syncBadge();
    /* 回到前台时重算标题栏未读（进过房间的已清零，剩下的才显示） */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        /* 切到后台就作废门禁：回来要重新输保护密码。
           账号凭据保留（如果勾了记住），所以只需补一次保护密码。 */
        clrGate();
        return;
      }
      if (g.Notifier) g.Notifier.onFocus();
      syncBadge();
      /* 回到前台：门禁没了就重新弹，不能让界面停在一个已失效的状态 */
      if (!gateOk()) reenterGate();
    });
    window.addEventListener('focus', function () {
      if (g.Notifier) g.Notifier.onFocus();
    });
    g.Net.loadAccel().then(function (ok) { if (ok) g.UI.toast('已启用 C++/WASM 哈希加速', 'ok'); });
    /* 上次没写完就离开了（S-120）。
       启动时检查一次：有就明确告知并让他决定要不要恢复，
       **不能静默恢复** —— 静默恢复和静默丢失一样糟，
       用户不知道发生过什么，下次还是会以为什么都没丢。 */
    (function restoreLeaveDraft() {
      var raw = null;
      try { raw = localStorage.getItem('wxlg_leave_draft'); } catch (e) { return; }
      if (!raw) return;
      var d = null;
      try { d = JSON.parse(raw); } catch (e2) { return; }
      if (!d || !d.text) return;
      var rn = d.room && findRoom(d.room) ? findRoom(d.room).name : (d.room || '未知会话');
      g.UI.confirm('上次离开时有一段没来得及保存的内容（在「' + g.UI.esc(rn) +
        '」，' + d.text.length + ' 字）。要恢复吗？', function () {
        var ta = $('input');
        if (ta && cur === d.room) { ta.value = d.text; autoGrow(ta); }
        else { drafts[d.room] = d.text; }
        save(true); renderChat();
        g.UI.toast('已恢复，请确认内容是否完整', 'ok', 6000);
        try { localStorage.removeItem('wxlg_leave_draft'); } catch (e3) { }
      }, function () {
        try { localStorage.removeItem('wxlg_leave_draft'); } catch (e4) { }
      });
    })();
    startHeartbeat();
    /* ⚠ 上次录音没走完就崩了 / 被关掉了（S-116，成品审查新增）。
       边录边存的草稿还在，但界面上什么都没有 ——
       用户不知道自己有一段 40 秒的语音留在那儿。
       启动时检查一次，有就明确告诉他，而不是让它悄悄烂在存储里
       还占着本来就紧张的配额。 */
    (function checkOrphanRecording() {
      var d = null;
      try { d = localStorage.getItem('wxlg_rec_draft'); } catch (e) { return; }
      if (!d) return;
      g.UI.confirm('上次有一段未完成的录音（约 ' + Math.max(1, Math.round(d.length / 1400)) +
        ' KB）。它可能是在录的过程中被中断的。要保留吗？', function () {
        /* 保留：什么都不做，等下次录音开始时会覆盖 */
        g.UI.toast('已保留。下次开始录音时会被新的覆盖', 'ok');
      }, function () {
        try { localStorage.removeItem('wxlg_rec_draft'); } catch (e2) { }
        g.UI.toast('已清除未完成的录音', 'ok');
      });
    })();
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

  /**
   * 系统消息。
   *
   * ⚠ 全仓系统消息**都不进服务端**（E-081），包括
   *   「X 通过了审核」「X 被禁言」「站长已转让给 X」「消息已被管理员清空」……
   *   这些恰恰是**最该让所有人看到**的内容 —— 一个只在本机出现的
   *   "站长已转让" 提示，会让其他所有人完全不知道站长换人了。
   *
   * 接服务端是后续的事；在接之前，这里如实标注，不假装它同步过。
   * 提示只在**在线模式**下给一次（本地模式本就没有服务端，说了没意义）。
   */
  var _sysOfflineTip = false;
  function sysMsg(rid, text) {
    msgs(rid).push({ id: uid('msg'), room: rid, from: 'system', type: 'system', text: text, ts: now() });
    if (!_sysOfflineTip && g.Online && g.Online.isOnline && g.Online.isOnline()) {
      _sysOfflineTip = true;
      g.UI.toast('系统提示只记录在本机，暂不会同步给其他成员', 'err', 6000);
    }
  }

  /* 本地模式下每个房间的消息上限（S-059）。
     服务端有 30 天窗口 + 字数上限，本地模式**完全没有** ——
     消息可以无限累积。叠加心跳每次全量序列化整个状态写盘，
     结果是：用得越久越慢，到某个点 localStorage 写满，
     然后"发送失败"但界面看不出原因。

     所以本地也要有上限。超过就丢最老的 ——
     但**不能静默丢**：静默丢历史等于数据丢失却没人知道。 */
  var LOCAL_MSG_MAX = 5000;

  /* 本地模式的登录失败计数（S-069）。
     服务端已经限流了，本地模式却没有 ——
     而用户在断网/换设备时走的正是本地路径。
     降级路径不该比正常路径松，否则限流形同虚设：
     攻击者只要让目标断网就能绕过。 */
  /* 本机提交过的注册申请昵称。用于只向本人回显拒绝理由（见注册面板）。 */
  var MY_APPLY_KEY = 'wxlg_myapply';
  var LOCAL_LOGIN_MAX = 8;
  var LOCAL_LOGIN_KEY = 'wxlg_loginfail';
  var memLoginFail = 0;   /* localStorage 不可用时的兜底计数（见下） */
  function localLoginFail() {
    try {
      var raw = JSON.parse(localStorage.getItem(LOCAL_LOGIN_KEY) || '{}');
      var now2 = Date.now();
      if (!raw.at || now2 - raw.at > 15 * 60 * 1000) raw = { n: 0, at: now2 };
      raw.n = (raw.n || 0) + 1;
      raw.at = now2;
      localStorage.setItem(LOCAL_LOGIN_KEY, JSON.stringify(raw));
      return raw.n;
    } catch (e) {
      /* ⚠ 原来 catch 里 return 0 —— 意思是"没有失败记录，不限制"。
         问题：localStorage 写不进去时（隐私模式、配额满）
         每次都走这条分支，**限流被完全绕过**，想试多少次试多少次。
         **安全控制失败时必须"闭"而不是"开"**：
         记不住就当已经失败很多次，直接锁住。
         宁可误伤一个用隐私模式的用户，也不能让限流形同虚设。 */
      memLoginFail++;
      return memLoginFail;
    }
  }
  function clearLocalLoginFail() {
    try { localStorage.removeItem(LOCAL_LOGIN_KEY); } catch (e) { }
  }

  function pushMsg(m) {
    var arr = msgs(m.room);
    arr.push(m);
    if (arr.length > LOCAL_MSG_MAX) {
      var cut = arr.length - LOCAL_MSG_MAX;
      arr.splice(0, cut);
      /* 只在本地模式提示：在线模式下服务端才是权威，
         本地被裁掉的消息重新拉取就能回来，不值得打扰用户。 */
      if (!(g.Online && g.Online.isOnline && g.Online.isOnline())) {
        g.UI.toast('本房间消息超过 ' + LOCAL_MSG_MAX + ' 条，已移除最早 '
          + cut + ' 条（本地存储有限）', 'err', 5000);
      }
    }
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
      /* ⚠⚠ renderRooms() **全项目没有定义**（正确的名字是 renderSidebar）。
         每收到一条别人发来的、不在当前房间的消息，这里就抛 ReferenceError。

         后果链：
           ① 房间列表不重绘 —— 未读红点要等到别处偶然触发 renderSidebar 才出现，
              用户以为没新消息；
           ② 抛出后 noteIncoming 后续逻辑中断；
           ③ 错误继续往调用方冒泡，可能打断整条消息处理流程。

         这是"写了调用、忘了定义"，和 data-mid（写了读、忘了写）、
         btnSearchMsg（写了引用、忘了建入口）是同一家族 ——
         都是**不崩溃、只是功能悄悄消失或半途中断**。 */
      renderSidebar();
    } else if (isAtMe(m)) {
      g.UI.toast('有人 @ 了你', 'ok');
    }
    /* @我 的提醒优先级更高：标题闪烁文案直接换成这个 */
    if (isAtMe(m) && g.Notifier) g.Notifier.setFlashText('有人 @ 了你');
    /* 系统消息不通知：那是自己操作的回显，弹出来只会莫名其妙 */
    if (m.type === 'sys') { syncBadge(); return; }
    if (g.Notifier) {
      var r = findRoom(m.room);
      var u = S.users.filter(function (x) { return x.id === m.from; })[0];
      var txt = m.text || '';
      if (!txt) {
        txt = ({ image: '[图片]', video: '[视频]', voice: '[语音]', file: '[文件]' })[m.type] || '[消息]';
      }
      g.Notifier.incoming({
        roomId: m.room,
        roomName: r ? roomTitleOf(r) : '',
        fromName: u ? u.nick : '有人',
        text: txt,
        mine: false
      });
    }
    syncBadge();
  }

  /* 未读数写进标题栏：页面切到后台时这是唯一看得见的地方 */
  function syncBadge() {
    if (!g.Notifier) return;
    var n = 0;
    for (var k in unread) n += (unread[k] || 0);
    g.Notifier.setUnread(n);
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
    /* ⚠ 走 Sync 模块提供的通道，不再取 g.__syncBc（E-061）。
       那个变量零处赋值，原来这段代码从未真正发出过一条广播。 */
    if (g.Sync && g.Sync.sendTyping) g.Sync.sendTyping({ nick: me && me.nick, room: cur });
  }

  /* 收到别人"正在输入"的广播 → 显示出来（E-061）。
     原来 showTyping 定义了但零处调用，广播到了也没人显示。 */
  function onTypingBroadcast(d) {
    if (!d || !me) return;
    if (d.from && d.from === me.id) return;        /* 不看自己的回声 */
    if (d.room && cur && d.room !== cur) return;   /* 只显示当前房间 */
    showTyping(d.nick || '有人');
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

  /* 服务端数据变了才用的重绘入口。
     增量同步可能在一帧里来好几次（消息 + 成员 + 房间），
     每次都全量重建会卡，所以走节流版。 */
  function renderAllSoon() {
    if (!me) return;
    renderMe(); renderSidebar(); renderChatSoon();
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
      /* 免打扰要有可见标识：静音了却看不出来，用户会以为消息丢了。
         主流聊天工具多用铃铛加斜杠，这里沿用这个约定。 */
      if (g.Notifier && g.Notifier.roomMuted(r.id)) {
        var muteIc = elc('div', 'room-mute');
        muteIc.title = '已免打扰';
        muteIc.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-bell-off"/></svg>';
        right.appendChild(muteIc);
      }
      /* 免打扰时不显红点：既然说了"不提醒"，就别再用红点制造焦虑。
         但 @我 仍然要显示 —— 那是明确指向本人的，不该被静音吞掉。 */
      var at = atMe[r.id] || 0;
      if (at > 0 && r.id !== cur) {
        right.appendChild(elc('div', 'badge at', '[有人@我]'));
      } else if (n > 0 && r.id !== cur) {
        if (!(g.Notifier && g.Notifier.roomMuted(r.id))) {
          right.appendChild(elc('div', 'badge', n > 99 ? '99+' : String(n)));
        }
      }
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

  /* ⚠ 用服务端时间，不能用本机时钟（E-049）。
     lastSeen 来自服务端，本机钟快 5 分钟 → 全员离线；慢 → 全员在线。
     这种错最难排查：现象是"在线状态不准"，根因在时钟。 */
  function serverNowSafe() {
    return (g.Online && g.Online.serverNow) ? g.Online.serverNow() : Date.now();
  }

  function isOnline(u) {
    if (!u) return false;
    return (u.lastSeen || 0) > (serverNowSafe() - ONLINE_MS);
  }

  /* 写盘健康状态（S-114，成品审查新增）。
     一条会消失的 toast 拦不住「以为在保存、实际没存」：
     它消失后，界面上再无任何痕迹表明"你现在正在丢数据"。
     所以另设一个**一直挂着**的红色标记，写盘恢复成功才消失。 */
  var saveFailing = false;
  function markSaveFailed(reason) {
    if (!saveFailing) {
      saveFailing = true;
      /* 首次仍弹一次详细说明，之后靠常驻标记提醒 */
      g.UI.toast('本地存储写入失败，改动只存在内存里，关闭页面会丢失。'
        + '建议导出备份后清理旧媒体。', 'err', 8000);
      try { console.error('[save] localStorage 写入失败', reason); } catch (e) { }
    }
    var w = $('saveWarn');
    if (w) {
      w.classList.remove('hidden');
      w.title = '本地存储写入失败（' + ((reason && reason.name) || '未知原因')
        + '）：改动只存在内存里，关闭页面会丢失。点这里立刻导出备份。';
      /* ⚠ 常驻标记必须给出可执行的出路（S-121，借鉴 Code 报告）。
         原来只有一个红标签，用户看到了也不知道该干嘛 ——
         被告知"正在丢数据"却没有任何补救动作，只会更焦虑。
         Code 的做法是「常驻 + 弹一次 + 给出备份出口」，
         三样缺一不可：只弹窗看不见（他在看别处），
         每次都弹是骚扰，而没有出口则等于把问题扔回给用户自己扛。 */
      if (!w._bound) {
        w._bound = true;
        w.style.cursor = 'pointer';
        w.onclick = function () {
          g.UI.confirm('存储写入失败，改动只存在内存里，关闭页面会全部丢失。\n\n'
            + '现在导出一份完整备份吗？（含媒体本体）', function () {
            /* 必须用 buildFullBackup，不能用 JSON.stringify(S) ——
               那个不含媒体，照它"备份"完再清理，媒体就永久没了。
               这条在这里尤其要命：正因为存储写不进去才来导出，
               如果导出的又是一份不含媒体的假备份，等于什么都没救回来。 */
            g.UI.toast('正在打包，请稍候…', 'ok');
            buildFullBackup(function () { }).then(function (pack) {
              var n = Object.keys(pack.media || {}).length;
              var blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
              var a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e0) { } }, 60000);
              a.download = 'chat-backup-' + new Date().toISOString().slice(0, 10) + '.json';
              a.click();
              g.UI.toast('已导出（含 ' + n + ' 个媒体）。注意：内存里未保存的改动不在备份中', 'ok', 8000);
            }).catch(function (e) {
              g.UI.toast('导出失败：' + ((e && e.message) || '未知错误'), 'err', 8000);
            });
          });
        };
      }
    }
    /* Q-Chat-E-105：body 上挂这个类是给 CSS 用的（输入框描红边），
       让"正在丢数据"跟着用户走，而不是只在顶部固定位置提示一次。 */
    document.body.classList.add('save-failing');
  }
  function markSaveOk() {
    if (!saveFailing) return;
    saveFailing = false;
    var w = $('saveWarn');
    if (w) w.classList.add('hidden');
    document.body.classList.remove('save-failing');
    g.UI.toast('存储已恢复，改动可以正常保存了', 'ok');
  }

  var hbTimer = null;
  function startHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);
    var beat = function () {
      if (!me) return;
      me.lastSeen = now();
      /* ⚠ 原来空 catch（S-053）：写盘失败完全静默。
         而这个心跳每 15 秒就全量序列化整个状态写一次 ——
         状态越大越容易失败，失败却没人知道。
         用户最终看到的现象是"聊了很久之后，某些改动莫名其妙丢了"，
         而真正的报错早就在空 catch 里被吞掉了。

         所以失败要说出来。但不能每次心跳都弹（15 秒一次太吵），
         用一个标志节流成"只报一次"。 */
      /* ⚠ 失败要持续可见，不能只报一次（S-114）。
         原来用 beat._warned 节流成"只报一次"——
         于是存在这样一种状态：**心跳一直在失败，用户只在最初看到过一次提示，
         之后界面完全正常，而所有改动都只在内存里**。
         这时候崩溃，全丢，且用户事前毫不知情。 */
      try { localStorage.setItem(KEY, JSON.stringify(S)); markSaveOk(); }
      catch (e2) { markSaveFailed(e2); }
      /* 轻量广播，让其他标签刷新在线状态 */
      g.Sync.ping();
      /* 账号凭据续期：只要还在线，"在线即有效"就一直成立 */
      tickMe();
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
      /* ⚠ 文字和 title 必须一致地表达"当前状态 + 点击后的动作"（E-022）。
         按钮文字写的是**当前**模式（极简/专业），
         而 title 是『当前：X（点此切到 Y）』——两者必须同步，
         否则用户看文字是「专业」、看提示是「当前极简」，只会以为功能坏了。 */
      btn.textContent = m === 'simple' ? '极简' : '专业';
      btn.title = m === 'simple' ? '当前：极简模式（点此切到专业）' : '当前：专业模式（点此切到极简）';
      btn.setAttribute('aria-label', btn.title);
    }
    renderChat();
    if (!silent) g.UI.toast(m === 'simple' ? '已切到极简模式' : '已切到专业模式', 'ok');
  }

  /* 渲染节流：连续多次触发只渲染最后一次。
     轮询、输入、成员变动可能在同一帧里各叫一次 renderChat，
     每次都重建几百个消息 DOM 的话，低端机会明显卡顿。 */
  var _renderPending = false;
  function renderChatSoon() {
    if (_renderPending) return;
    _renderPending = true;
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(function () {
      _renderPending = false;
      renderChat();
    }, 0);
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
        /* 用 fmtDay 而不是 fmtTime：分隔线要说的是"哪一天"，不是"几点" */
        box.appendChild(elc('div', 'time-sep', g.UI.fmtDay(m.ts)));
      }
      box.appendChild(cachedMsgNode(m, r));
    });
    /* 还有更早的消息时：
       - 顶部放「加载更早」按钮（可点）
       - 同时挂滚动监听，滚到顶部自动再翻一页
       两者并存：按钮给确定性，滚动给连续性。
       只做按钮的话，用户得反复点才能翻回很久以前。 */
    if (full.length > shown) {
      var more = elc('button', 'load-more', '▲ 加载更早的 ' + (full.length - shown) + ' 条');
      more.onclick = function () {
        loadEarlier(full.length);
      };
      box.insertBefore(more, box.firstChild);
      bindLoadEarlierOnScroll(full.length);
    } else {
      unbindLoadEarlierOnScroll();
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
      s.setAttribute('data-mid', m.id);
      return s;
    }
    var u = findUser(m.from);
    var mine = m.from === me.id;
    var row = elc('div', 'msg-row' + (mine ? ' me' : ''));
    /* ⚠⚠ data-mid 被两处查询（置顶消息点击定位、搜索结果跳转），
       但**从来没有地方设置过它** —— 全项目零处赋值。
       于是那两个 querySelector 永远返回 null，
       点击后静默什么也不做。

       这是最典型的一类"写了读、忘了写"：读的那两处都加了 if (nd) 保护，
       所以不报错、不崩溃，只是功能完全不存在。
       用户点了置顶消息没反应，只会以为这个按钮是装饰。 */
    row.setAttribute('data-mid', m.id);
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
        /* Q-Chat-E-106：btn-src 是给 CSS 用的钩子。
           极简模式下要隐藏它（"查看原文"是专业向功能），
           但不能用 msg-act —— 引用/复制/编辑共用这个 class，
           一并隐藏的话极简模式下连"复制"都用不了，那是误伤。 */
        var see = elc('button', 'msg-act btn-src', '查看原文');
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
      /* 待发送：离线期间攒下的消息。
         不标的话用户以为发出去了，其实还在本机排队。 */
      if (m.pending) {
        var pd = elc('span', 'msg-pending', '待发送');
        pd.title = '联网后自动发出';
        bubble.appendChild(pd);
      }
      /* ⚠ m.failed 被设置了（存入队列失败时），但**渲染层从来没用过它**。
         后果：那条消息看起来和正常发出去的一模一样 ——
         没有"待发送"、没有失败标记。
         当时弹过一句 toast，2 秒就没了；
         之后用户翻回这段聊天，只看到一条普通消息，
         以为对方收到了，实际上它永远不会发出去。

         **静默丢失比丢消息本身更糟**：丢了还有机会重发，
         以为发出去了则连补救的机会都没有。
         所以这里必须给出持久可见的标识，并且能点一下重试。 */
      if (m.failed && !m.pending) {
        /* E-082-FAILED：失败态必须看得见，否则发送失败的消息和正常消息一模一样。 */
        var fd = elc('span', 'msg-failed', '未发出');
        fd.title = '点击重试';
        fd.style.cursor = 'pointer';
        fd.onclick = function () {
          delete m.failed;
          m.pending = true;
          if (g.Online && g.Online.enqueue) {
            var rr = g.Online.enqueue({
              room: m.room, type: m.type, body: m.text || '', localId: m.id,
              mediaId: m.mediaId || null, name: m.name || '', size: m.size || 0,
              replyTo: m.replyTo || null
            });
            if (!rr || rr.ok === false) {
              m.pending = false; m.failed = true;
              g.UI.toast('重试失败：' + ((rr && rr.reason === 'quota') ? '存储已满' : '队列写入失败'), 'err');
            } else {
              g.UI.toast('已重新加入待发送队列', 'ok');
            }
          }
          save(); renderChat();
        };
        bubble.appendChild(fd);
      }
      /* 已编辑角标：不标的话，别人看到的内容和记忆里不一样却无从察觉，
         还以为是自己的问题。 */
      if (m.editedAt) {
        var ed = elc('span', 'msg-edited', '已编辑');
        ed.title = '编辑于 ' + g.UI.fmtFull(m.editedAt);
        bubble.appendChild(ed);
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
          /* ⚠ 不能用同步 try/catch 包 Promise（E-090，考古补回）。
             writeText() 返回 Promise，它的 reject **不会被同步 catch 捕获** ——
             于是"复制失败"永远走不到，界面一律显示「已复制」。
             用户以为复制好了，粘贴出来却是上一次的内容，或者空。
             **谎报成功比不报更糟**：不报用户还会自己手动选一遍。

             另外 clipboard API 在非安全上下文（file://、http）下 navigator.clipboard
             直接是 undefined，原代码会抛 TypeError 被 catch 成"复制失败"——
             那还算诚实；真正危险的是 Promise reject 那一路。 */
          copyText(m.text || '');
        };
        acts.appendChild(bCopy);
      }
      /* 编辑：只有本人、只有文本消息、且在时限内。
         媒体消息不给改 —— 换附件等于换内容，性质不同于改错别字。 */
      if (mine && m.type === 'text' && !m.deleted &&
          g.ACL.can(me, 'msg.edit', r) && (serverNowSafe() - (m.ts || 0)) < EDIT_MS) {
        var bE = elc('button', 'msg-act', '编辑');
        bE.onclick = function () { doEdit(m, r); };
        acts.appendChild(bE);
      }
      /* 撤回：作者本人，限时 RECALL_MS 内。
         ⚠ 超时后不能让按钮凭空消失（E-064，考古补回）。
         原来超时就整个不渲染 —— 用户过了 6 分钟想撤回，
         发现按钮没了，不知道是超了时限，只会以为功能坏了或自己没权限。
         **功能不可用要给出原因，不给原因就等于让人猜。**
         这里渲染一个禁用按钮，title 说明时限已过。 */
      if (mine && g.ACL.can(me, 'msg.recall', r)) {
        var leftMs = RECALL_MS - (serverNowSafe() - (m.ts || 0));
        if (leftMs > 0) {
          var bR = elc('button', 'msg-act', '撤回');
          bR.onclick = function () { doRemove(m, 'recall'); };
          bR.title = '发送后 ' + Math.ceil(RECALL_MS / 60000) + ' 分钟内可撤回';
          acts.appendChild(bR);
        } else {
          var bRx = elc('button', 'msg-act disabled', '撤回');
          bRx.disabled = true;
          bRx.title = '已超过 ' + Math.ceil(RECALL_MS / 60000) + ' 分钟，不能撤回了';
          acts.appendChild(bRx);
        }
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
        /* ⚠ i-pin 这个图标画好了却从未使用（E-097-ICON）。
           置顶是高频操作，纯文字按钮挤在消息操作区里，
           和其他图标按钮风格不一致 —— 备好的图标不用，等于白画。 */
        var bPin = elc('button', 'msg-act', '');
        bPin.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-pin"/></svg>'
          + '<span>' + ((r.pinned && r.pinned.indexOf(m.id) >= 0) ? '取消置顶' : '置顶') + '</span>';
        bPin.onclick = function () { togglePin(m); };
        acts.appendChild(bPin);
      }
      /* Delete：物理删除，释放空间，仅站长 */
      if (me.role === 'owner') {
        /* ⚠ 按钮文字原来是英文「Delete」（S-110 核实）。
           同一排按钮里：删除、移除、Delete —— 前两个是中文，唯独这个是英文。
           更糟的是它和上面的「删除」是**两种不同的删除**：
             删除 = 逻辑删除（可恢复）
             Delete = 物理抹除（不可恢复）
           而界面上这两个长得几乎一样，用户根本分不清哪个能后悔。
           改成中文并让字面就带出区别：「抹除」——和「删除」明显不是一回事。 */
        var bPurge = elc('button', 'msg-act danger', '抹除');
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
    } else if (m.type === 'video') {
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
    /* ⚠ 这里原来是 `} else {`，无条件兜底（E-092，考古找回）。
       后果：voice 和 file 消息都会先走 else 创建出一个空的 <video>，
       然后才追加各自的 voiceNode / 下载按钮 ——
       发一条语音，界面上出现一个空的视频框 + 语音条；
       发一个文件，出现一个空的视频框 + 下载按钮。
       改成 else if 后，非 image 且非 video 的类型不再凭空造 video 元素。 */
    if (m.type === 'voice') { wrap.appendChild(voiceNode(m)); }
    var cap = elc('div', 'media-cap', (m.name || '媒体') + (m.size ? ' · ' + g.Media.fmtSize(m.size) : ''));
    if (m.type === 'file') {
      var dl = elc('button', 'file-dl', '下载 ' + g.UI.esc(m.name || '文件'));
      dl.onclick = function () {
        g.Media.get(m.mediaId).then(function (u) {
          if (!u) { g.UI.toast('这个文件没同步到这台设备'); return; }
          var a = document.createElement('a');
          a.href = u; a.download = m.name || 'file'; a.click();
        });
      };
      wrap.appendChild(dl);
    }
    wrap.appendChild(cap);

    /* 占位态：本地没命中、远端也取不到时的兜底。
       原来这里是 `if (!u) return;` —— 什么都不做，用户只看到一个灰色方块，
       不知道是还在加载、没权限、还是数据没了。而且同类不一致：
       文件会提示「文件数据已丢失」、语音会提示「语音数据已丢失」，
       只有图片和视频是静默的。同一个问题三种处理。
       现在统一：给一个能看懂的占位态，并且可重试。 */
    function showMissing() {
      var ph = elc('div', 'media-missing');
      ph.innerHTML =
        '<svg class="ic" aria-hidden="true"><use href="#i-image"/></svg>' +
        '<span>' + (m.type === 'video' ? '这个视频没同步到这台设备'
                                       : '这张图没同步到这台设备') + '</span>' +
        '<button class="media-retry" type="button">重试</button>';
      ph.querySelector('.media-retry').onclick = function (e) {
        e.stopPropagation();
        ph.remove();
        load();
      };
      wrap.insertBefore(ph, cap);
      /* 占位态下把媒体元素藏掉，避免灰块和提示叠在一起 */
      if (m.type === 'image') img.style.display = 'none';
      else if (v) v.style.display = 'none';
    }

    function load() {
      if (!m.mediaId) { showMissing(); return; }
      g.Media.get(m.mediaId).then(function (u) {
        if (!u) { showMissing(); return; }
        if (m.type === 'image') img.src = u;
        else if (v && !v.src) v.src = u;
      }).catch(function () { showMissing(); });
    }
    load();
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
  /* ⚠ 消息长度上限必须与服务端一致（S-101，考古补回）。
     服务端 msg_send / msg_edit 都限 8000 字，超限直接 raise。
     而前端**零校验**：用户写了 12000 字，一路顺畅地发出去，
     直到服务端拒绝才弹一句「消息过长」——
     这时他已经写了很久，且输入框已清空（send 里先 ta.value = ''），
     **内容没了**。写了半小时的东西因为一个本可提前拦截的限制而丢失，最冤。

     所以：提交前就拦住，并且只提示、不清空输入框。 */
  var MSG_MAX = 8000;

  function send() {
    var ta = $('input');
    var text = ta.value.replace(/\s+$/, '');
    if (!text) return;
    if (text.length > MSG_MAX) {
      g.UI.toast('消息太长（' + text.length + ' 字，上限 ' + MSG_MAX +
        '）。内容已保留，请删减后再发。', 'err', 8000);
      return;
    }
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

    /* 发送：在线就直接发，离线就进队列等联网补发。
       两条路都先在界面上显示出来（乐观更新），
       离线那条标「待发送」，别让用户以为发出去了。 */
    if (g.Online && g.Online.isOnline && g.Online.isOnline()) {
      g.Online.sendMsg(cur, 'text', text, null, '', 0, m.replyTo || null)
        .catch(function (e) {
          /* ⚠ 原来只弹一句 toast 就完了。
             而这条消息**已经 pushMsg 显示到聊天里了** ——
             toast 几秒后消失，消息却原样留在那儿，
             看上去和发出去的一模一样。

             用户以为对方收到了，其实没有；
             而且它没进队列，永远不会补发。
             **静默丢失**：丢了还以为成功了，连重发的机会都没有。

             正确做法：在线发送失败 = 此刻实际处于离线，
             那就走和离线一样的路径 —— 入队等补发。
             入队也失败才标 failed（红色「未发出」，可点击重试）。 */
          var why = (e && e.message) ? e.message : '网络错误';
          if (g.Online && g.Online.enqueue) {
            var rr = g.Online.enqueue({
              room: cur, type: 'text', body: text, media: null,
              name: '', size: 0, replyTo: m.replyTo || null, localId: m.id
            });
            if (rr && rr.ok !== false) {
              m.pending = true;
              save(); renderChat();
              var dropTip = (rr && rr.dropped > 0)
                ? '注意：队列已满，丢弃了最早 ' + rr.dropped + ' 条待发消息。'
                : '';
              g.UI.toast('暂时没发出去，已加入待发送队列（' + why + '），联网后自动补发。' + dropTip, 'err', 6000);
              return;
            }
          }
          m.failed = true;
          save(); renderChat();
          g.UI.toast('发送失败且未能入队：' + why + '。这条消息标记为「未发出」，可点击重试。', 'err', 8000);
        });
    } else if (g.Online && g.Online.enqueue) {
      /* localId 必须带上：补发成功时要用它把本地临时 id 换成服务端 id，
         否则 pull 回来后同一条消息会有两个 id，界面上出现两遍（S-043）。 */
      var res = g.Online.enqueue({
        room: cur, type: 'text', body: text, media: null,
        name: '', size: 0, replyTo: m.replyTo || null, localId: m.id
      });
      if (res && res.ok === false) {
        /* 没存住就不能标"待发送" —— 标了等于告诉用户"迟早会发出去"，
           而它其实已经丢了。这是最糟的一种骗法（S-045）。 */
        m.pending = false;
        m.failed = true;
        save(); renderChat();
        g.UI.toast(res.reason === 'quota'
          ? '本地存储已满，这条消息没能存下'
          : '这条消息没能存入待发送队列', 'err');
      } else {
        m.pending = true;
        save(); renderChat();
        /* ⚠ dropped 必须读出来告诉用户（E-007，考古补回）。
           enqueue() 在队列超限时会丢掉最旧的一条并把这个数返回，
           而这里原来只判断 res.ok，**dropped 一次都没读**。
           于是：攒满之后每发一条新的，就有一条最旧的被悄悄丢掉；
           界面上那些旧消息仍挂着「待发送」角标，
           **但它们已经不在队列里，永远不会发出去**。

           这和"没存住就不标待发送"是同一类骗法，只是触发条件不同：
           一个是存不下，一个是被挤掉 —— 结果都是用户以为会发出去。 */
        if (res && res.dropped > 0) {
          g.UI.toast('已存入队列，但队列已满，丢弃了最早 ' + res.dropped +
            ' 条待发消息（它们不会发出去了）', 'err', 6000);
        } else {
          g.UI.toast('已存入待发送队列，联网后自动发出', 'ok');
        }
      }
    }
  }

  /* ⚠ 时限必须用服务端时间算（S-065）。
     m.ts 在线模式下来自服务端 created_at，而 now() 是本机时钟 ——
     钟慢的人可以把任意旧消息判成"刚发的"，从而撤回本不该撤回的；
     钟快的人刚发的消息都撤不回。
     **时限是业务规则，不能由客户端时钟决定谁守规则。** */
  var RECALL_MS = 5 * 60 * 1000;   /* 撤回时限：5 分钟 */
  var EDIT_MS = 10 * 60 * 1000;    /* 编辑时限：10 分钟，比撤回宽松一点 */

  function doRemove(m, mode) {
    var r = findRoom(cur);
    if (!r) return;
    /* mode: recall 本人撤回 / remove 管理员移除 / purge 站长物理删除 */
    if (mode === 'recall') {
      if (m.from !== me.id) { g.UI.toast('只能撤回自己的消息', 'err'); return; }
      if ((serverNowSafe() - (m.ts || 0)) >= RECALL_MS) { g.UI.toast('超过 5 分钟，不能撤回了', 'err'); return; }
      m.deleted = true; m.removedBy = null;
      log('recall', '撤回自己的消息', r.id);
      save();
      /* 同步服务端（S-082）。失败必须改口 ——
         「已撤回」是对别人的承诺，服务端没撤成就说了等于骗人。 */
      if (g.Online && g.Online.deleteMsg) {
        g.Online.deleteMsg(m.id).then(function (done) {
          if (done) { g.UI.toast('已撤回', 'ok'); return; }
          g.UI.toast('本机已撤回，但服务端没能同步，其他人仍看得到', 'err');
        }).catch(function (e) {
          g.UI.toast('撤回失败：' + g.UI.esc((e && e.message) || '未知原因'), 'err');
        });
      } else {
        g.UI.toast('已撤回', 'ok');
      }
    } else if (mode === 'remove') {
      if (m.from === me.id) { g.UI.toast('自己的消息请点「撤回」', 'err'); return; }
      m.deleted = true; m.removedBy = me.id;
      log('remove', '移除「' + nick(findUser(m.from)) + '」的消息', r.id);
      save();
      /* 同上：管理员移除对别人同样生效，必须同步服务端 */
      if (g.Online && g.Online.deleteMsg) {
        g.Online.deleteMsg(m.id).then(function (done) {
          if (done) { g.UI.toast('已移除该消息', 'ok'); return; }
          g.UI.toast('本机已移除，但服务端没能同步', 'err');
        }).catch(function (e) {
          g.UI.toast('移除失败：' + g.UI.esc((e && e.message) || '未知原因'), 'err');
        });
      } else {
        g.UI.toast('已移除该消息', 'ok');
      }
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
      log('delete', '删除消息（来自「' + nick(findUser(m.from)) + '」）', r.id);
      save();
      /* ⚠ 原来这里写的是英文调试串「已 delete」（S-091，考古找回）。
         同一组操作里旁边写的是「已撤回」「已删除（仅你这里不再显示）」，
         唯独这条混进一个没翻译的英文原词，用户会以为出了什么错。 */
      if (g.Online && g.Online.deleteMsg) {
        g.Online.deleteMsg(m.id).then(function (done) {
          if (done) { g.UI.toast('已删除', 'ok'); return; }
          g.UI.toast('本机已删除，但服务端没能同步', 'err');
        }).catch(function (e) {
          g.UI.toast('删除失败：' + g.UI.esc((e && e.message) || '未知原因'), 'err');
        });
      } else {
        g.UI.toast('已删除', 'ok');
      }
    }
  }

  /* 按 MIME 判媒体类型：图片 / 视频 / 其余一律文件（E-060）。
     音频要单独看 —— 浏览器对 audio/* 的识别比 video/* 稳定，
     而且语音消息走的是 voice 类型，不该被塞进 image 分支。 */
  function mediaKindOf(f) {
    var t = (f && f.type) || '';
    if (/^image\//.test(t)) return 'image';
    if (/^video\//.test(t)) return 'video';
    return 'file';
  }

  /* 统一复制入口（E-090）：正确处理 Promise reject，绝不谎报成功。
     失败时若给了 fallback 文案，就把原文一并显示出来让用户能手动抄。 */
  function copyText(txt, failMsg) {
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var okDone = false;
      try { okDone = document.execCommand('copy'); } catch (e) { okDone = false; }
      ta.remove();
      if (okDone) { g.UI.toast('已复制', 'ok'); return; }
      g.UI.toast(failMsg || '复制失败，请手动复制', 'err', 6000);
    };
    if (!navigator.clipboard || !navigator.clipboard.writeText) { fallback(); return; }
    navigator.clipboard.writeText(txt).then(function () {
      g.UI.toast('已复制', 'ok');
    }).catch(function () { fallback(); });
  }

  /* 强制立即改密码（E-098）。
     关不掉、不能跳过：点了"确定"而没填，就再弹一次。
     这是重置站点后的唯一一道保险 —— 初始密码是随机生成的，
     站长必须立刻换成自己知道的，否则他自己也登不回去。 */
  function forceSetPassword(currentPwd, extraTip) {
    var showOnce = function () {
      g.UI.modal({
        title: '立即设置站长密码',
        okText: '设置', cancelText: null,
        body: (function () {
          var d = elc('div', '');
          d.innerHTML =
            '<div class="form-tip">当前初始密码：<code>' + g.UI.esc(currentPwd) + '</code></div>' +
            '<div class="field-hint">这是随机生成的临时密码，请立即改为你自己的密码并记牢。' +
            (extraTip ? '<br>' + g.UI.esc(extraTip) : '') + '</div>' +
            '<div class="form-row"><label>新密码</label><input id="np1" type="password" autocomplete="new-password"></div>' +
            '<div class="form-row"><label>再输一次</label><input id="np2" type="password" autocomplete="new-password"></div>';
          return d;
        })(),
        onOk: function (body) {
          var a = (body.querySelector('#np1') || {}).value || '';
          var b = (body.querySelector('#np2') || {}).value || '';
          if (a.length < 4) { g.UI.toast('密码至少 4 位', 'err'); return false; }
          if (a !== b) { g.UI.toast('两次输入不一致', 'err'); return false; }
          var sl = g.SHA256.randomId(12);
          me.pwdHash = hashPwd(a, sl); me.pwdSalt = sl; touch(me);
          save(); renderAll();
          g.UI.toast('密码已设置，请记牢', 'ok');
          return true;
        }
      });
      /* 用户可能用 Esc / × / 点遮罩关掉 —— 那就再弹一次，
         不给"待会儿再改"的机会。密码没设成就不能算重置完成。 */
      var watch = setInterval(function () {
        if (!document.querySelector('.modal')) {
          clearInterval(watch);
          /* 用哈希是否还是初始密码来判断有没有真的改过 */
          if (me && me.pwdHash === hashPwd(currentPwd, me.pwdSalt)) showOnce();
        }
      }, 300);
    };
    showOnce();
  }

  /* 离开页面时的同步兜底（S-120，借鉴 Code 报告的同一判据）。

     为什么必须"同步"：卸载时处理器一返回浏览器就开始卸载，
     **任何异步写入（Promise / IndexedDB 事务）都来不及提交**。
     Code 那条链路 `beforeunload → flushAll() → ed.save() → idb.put()`
     返回 Promise，正是死在这里 —— 代码里写着 beforeunload，
     读代码的人会以为做了，于是不会再去查。**"有钩子但不管用"比"没有钩子"更隐蔽。**

     Chat 在这里比 Code 有利：主状态走 localStorage，是**同步**的，
     卸载时确实能写完。但**媒体在 IndexedDB，卸载时救不回来** ——
     所以这里只同步写最关键的草稿，并明确告知媒体不在这个兜底范围内，
     不假装能兜住。 */
  function syncFlushOnLeave() {
    var wrote = false;
    try { wrote = save(true); } catch (e) { wrote = false; }
    /* ⚠ 只有主状态没写成时才留兜底（S-120）。
       save() 成功的话，草稿本就已经随 S 一起落盘了，
       再留一份是多余 —— 而且下次启动会弹一个"有未保存内容"，
       其实是**早就存好了**的，白白吓用户一跳。

       只有 save 真的失败（配额满、序列化异常）才单独写这份小的：
       save() 要序列化整个 S，状态大时最容易失败；
       而草稿是用户最不能丢的那几个字，单独写一份小的成功率更高。 */
    if (wrote) {
      try { localStorage.removeItem('wxlg_leave_draft'); } catch (e0) { }
      return;
    }
    try {
      var ta = $('input');
      if (ta && ta.value) {
        localStorage.setItem('wxlg_leave_draft', JSON.stringify({ room: cur, text: ta.value, at: Date.now() }));
      }
    } catch (e2) { markSaveFailed(e2); }
  }

  /* 字数提示（S-101）：超过 90% 才出现，超过上限变红。 */
  function updateLenHint(ta) {
    var el = $('lenHint');
    if (!el) return;
    var n = ta.value.length;
    if (n < MSG_MAX * 0.9) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    var over = n > MSG_MAX;
    el.textContent = n + ' / ' + MSG_MAX;
    el.classList.toggle('over', over);
    el.title = over ? '已超过上限 ' + (n - MSG_MAX) + ' 字，发送会被拒绝' : '接近长度上限';
  }

  /* 昵称合法性校验（S-100）。必须与服务端同一套规则：
     服务端是真正的闸门，前端只负责**提前**告诉用户，
     别让他填完一整张表才被拒。 */
  var NICK_RE = /^[\u4e00-\u9fa5a-zA-Z0-9_\-. ·‧]{1,24}$/;
  var NICK_INVISIBLE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/;
  function nickValid(n) {
    n = String(n || '');
    if (NICK_INVISIBLE.test(n)) return { ok: false, why: '昵称不能包含不可见字符' };
    if (n.length > 24) return { ok: false, why: '昵称最多 24 个字符' };
    if (!NICK_RE.test(n)) return { ok: false, why: '昵称只能包含中英文、数字、下划线、连字符和空格' };
    return { ok: true };
  }

  /* 该消息对「我」是否可见：被隐藏或已被撤回/移除都算不可见 */
  function visibleToMe(m) {
    if (!m) return false;
    if (m.hiddenFor && me && m.hiddenFor.indexOf(me.id) >= 0) return false;
    return true;
  }

  /* 我隐藏了多少条消息（用于「恢复已删除」） */
  /* 消息摘要（进日志用，便于后台追溯被撤回/移除/Delete 的内容） */
  /* ---------- 向前翻页（加载更早） ----------
     注意：MSG_PAGE 是「当前渲染多少条」，不是「从服务端拉多少条」。
     翻页只是把本地已有消息的渲染上限调大，不会重新打网络 ——
     消息本身早就随 state_delta 增量同步下来了。 */
  var _loadEarlierLock = false;
  var _earlierTotal = 0;      /* 存模块级：handler 闭包里用旧值会判错 */
  function loadEarlier(total) {
    if (MSG_PAGE >= total) return;
    /* ⚠ 翻页前先记下"当前顶部那条消息离视口顶端的距离"（E-012，考古补回）。
       原来注释写的是「翻页后要保持阅读位置，否则视口被顶下去，用户会跳一下，
       翻几页就彻底迷失了」——**紧接着的下一行就是 sc.scrollTop = 0，
       正是注释警告的那个做法**。注释和实现对着干。

       正确做法（同一文件里滚动自动加载用的就是它）：
       先记 scrollHeight，渲染后再按增量补偿 scrollTop。 */
    var sc0 = $('msgScroll');
    var before = sc0 ? sc0.scrollHeight : 0;
    var topBefore = sc0 ? sc0.scrollTop : 0;
    MSG_PAGE += 300;
    renderChat();
    var sc = $('msgScroll');
    if (sc) {
      var after = sc.scrollHeight;
      /* 新增内容都插在顶部，所以顶部偏移量就是两次高度之差 */
      sc.scrollTop = topBefore + (after - before);
    }
  }

  var _scrollHandler = null;
  function bindLoadEarlierOnScroll(total) {
    _earlierTotal = total;
    var sc = $('msgScroll');
    if (!sc) return;
    if (_scrollHandler) return;   /* 已绑定则不重复挂 */
    _scrollHandler = function () {
      if (_loadEarlierLock) return;
      if (sc.scrollTop > 40) return;          // 距顶部 40px 内才触发
      if (MSG_PAGE >= _earlierTotal) { unbindLoadEarlierOnScroll(); return; }
      _loadEarlierLock = true;
      /* 先记住当前内容的高度，翻页后按增量还原位置 */
      var before = sc.scrollHeight;
      MSG_PAGE += 300;
      renderChat();
      var sc2 = $('msgScroll');
      if (sc2) sc2.scrollTop = sc2.scrollHeight - before;  // 保持视觉锚点
      /* 节流：渲染 300 条 DOM 不小，别让它连续触发 */
      setTimeout(function () { _loadEarlierLock = false; }, 250);
    };
    sc.addEventListener('scroll', _scrollHandler, { passive: true });
  }

  function unbindLoadEarlierOnScroll() {
    var sc = $('msgScroll');
    if (sc && _scrollHandler) { sc.removeEventListener('scroll', _scrollHandler); }
    _scrollHandler = null;
  }

  /* ---------- 编辑已发出的消息 ----------
     本地改完立刻同步服务端；服务端失败要回滚本地并提示，
     否则用户以为改成功了，刷新一看还是原文。 */
  function doEdit(m, r) {
    var d = elc('div', '');
    var ta = elc('textarea', 'ta');
    ta.value = m.text || '';
    ta.rows = 5;
    ta.style.width = '100%';
    d.appendChild(ta);
    var note = elc('div', 'form-note');
    note.textContent = '改完会显示「已编辑」，对方能看到你改过。';
    d.appendChild(note);

    g.UI.modal({
      title: '编辑消息', body: d, okText: '保存', cancelText: '取消',
      onOk: function (body) {
        var v = body.querySelector('.ta').value;
        if (!v.trim()) { g.UI.toast('内容不能为空'); return false; }
        if (v === (m.text || '')) return true;      // 没改就不折腾

        var oldText = m.text;
        m.text = v;
        m.editedAt = now();
        save();
        renderChat();

        /* 在线模式同步到服务端。失败要回滚 —— 不能本地显示改了而服务端没改 */
        if (g.Online && g.Online.isOnline && g.Online.isOnline() && g.Online.editMsg) {
          g.Online.editMsg(m.id, v).catch(function (e) {
            m.text = oldText;
            m.editedAt = 0;
            save();
            renderChat();
            g.UI.toast('编辑未能同步到服务器：' + (e && e.message ? e.message : '网络错误'), 'err');
          });
        }
        return true;
      }
    });
  }

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
      /* editedAt 必须进指纹（S-036/047）。
         不进的话：服务端回滚编辑（editedAt 变 null）时指纹不变，
         缓存节点被复用 —— 「已编辑」标记不会消失。
         用户看到一条标着"已编辑"但内容没变的消息，非常费解。 */
      m.editedAt || 0,
      (m.hiddenFor && m.hiddenFor.indexOf(me && me.id) >= 0) ? 1 : 0,
      (r.pinned && r.pinned.indexOf(m.id) >= 0) ? 1 : 0,
      /* ⚠ pending / failed 必须进指纹。
         这两个直接决定消息旁边是否显示「待发送」角标。
         原来不在指纹里，于是：
           消息入队 → 渲染出「待发送」→ 节点进缓存；
           联网补发成功 → pending 置 false → 指纹**没变** →
           cachedMsgNode 命中旧缓存，直接复用那个还挂着「待发送」的节点。

         结果：消息明明已经发出去了，界面上一直挂着「待发送」。
         用户以为没发出去，很可能再发一遍 —— 对方收到两条一样的。

         这类 bug 的特点是不报错：逻辑全对、状态也改了，
         只是渲染层复用了过期节点。 */
      m.pending ? 1 : 0,
      m.failed ? 1 : 0
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
    /* ⚠ 置顶只改了本地（E-074-080-081 E-074）：换设备就消失，别人也看不到。
       在真正接服务端之前，**不能假装同步成功** ——
       否则用户以为全站都置顶了，实际只有自己这台机器看得见，
       等他换手机登录发现置顶没了，只会以为出了 bug。 */
    if (g.Online && g.Online.isOnline && g.Online.isOnline()) {
      g.UI.toast('置顶只改了本机，其他设备暂不会同步', 'err', 5000);
    }
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
    { var ph = elc('div', 'pinned-head');
         ph.appendChild(document.createTextNode('置顶 ' + items.length + ' 条'));
         ph.insertBefore(g.UI.svgIcon('i-pin'), ph.firstChild);
         host.appendChild(ph); }
    items.forEach(function (m) {
      var row = elc('div', 'pinned-row');
      var txt = m.type === 'text' ? g.MD.plain(m.text || '') : msgSnippet(m);
      var lab = elc('span', 'pinned-txt');
      lab.innerHTML = '<b>' + g.UI.esc(nick(findUser(m.from)) || '未知') + '</b>：' +
        g.UI.esc(txt.length > 60 ? txt.slice(0, 60) + '…' : txt);
      row.appendChild(lab);
      row.onclick = function () {
        /* ⚠ 和搜索跳转同一个毛病：只查一次，找不到就什么都不做。
           置顶消息常常是很久以前的，不在已渲染的最近 300 条里 ——
           点了没反应，用户只会以为这行文字不可点。
           找不到就继续翻页找；真找不到（被撤回/删除）要说一句。 */
        var tries = 0;
        (function locate() {
          var nd = document.querySelector('[data-mid="' + m.id + '"]');
          if (nd) {
            nd.scrollIntoView({ block: 'center' });
            nd.classList.add('flash');
            setTimeout(function () { nd.classList.remove('flash'); }, 1200);
            return;
          }
          var total = ((S.messages && S.messages[r.id]) || []).length;
          if (tries++ < 20 && MSG_PAGE < total) {
            MSG_PAGE += 300;
            renderChat();
            setTimeout(locate, 30);
            return;
          }
          g.UI.toast('没能定位到这条消息（可能已被撤回或删除）', 'err', 4000);
        })();
      };
      if (g.ACL.can(me, 'msg.pin', r)) {
        var x = elc('button', 'pinned-x');
        x.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-close"/></svg>';
        /* ⚠ 原来这里连续写了两遍 `x.title = '取消置顶';`（S-110 核实）。
           重复赋值本身无害，但它是**某次编辑留下的残渣** ——
           看到它的下一个人会以为漏了什么（比如第二行本该是别的值），
           于是犹豫要不要改。这种"看着像有玄机其实没有"的死代码要清掉。
           另外补 aria-label：这个按钮只有图标没有文字，
           屏幕阅读器读不出"取消置顶"，只能念出一个空按钮。 */
        x.title = '取消置顶';
        x.setAttribute('aria-label', '取消置顶');
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
      rec.ondataavailable = function (e) {
        if (!e.data || !e.data.size) return;
        recChunks.push(e.data);
        /* ⚠ 每来一片就攒进待落盘缓冲（S-116，成品审查新增）。
           原来整段录音只在内存里攒着，**只有点停止才组装写入**。
           录到 55 秒崩溃 → 55 秒全没，中途一次都没落盘过。

           录音是创作内容，比打字更不可恢复：
           打字的草稿还能凭记忆重写，说出去的话再说一遍就不是那回事了。
           所以这里边录边写。用 timeslice 让 MediaRecorder 每 5 秒吐一片。 */
        try {
          var r = new FileReader();
          r.onload = function () {
            try { localStorage.setItem('wxlg_rec_draft', String(r.result)); } catch (e2) { markSaveFailed(e2); }
          };
          r.readAsDataURL(new Blob(recChunks, { type: mime || 'audio/webm' }));
        } catch (e3) { }
      };
      rec.onstop = function () { finishRecord(stream); };
      /* 每 5 秒吐一片，配合上面的落盘 */
      try { rec.start(5000); } catch (e4) { rec.start(); }
      recStart = now();
      var tip = $('recTip'), sec = $('recSec');
      if (tip) tip.classList.remove('hidden');
      recTimer = setInterval(function () {
        var el = (now() - recStart) / 1000;
        if (sec) sec.textContent = Math.floor(el);
        /* ⚠ 接近上限要预警（E-018 同族）：
           界面从头到尾没写"最长 60 秒"，到点直接自动发送。
           用户正说到一半突然就发出去了，发的还是他不打算发的长度。 */
        var left = Math.ceil((VOICE_MAX_MS - (now() - recStart)) / 1000);
        if (sec) {
          sec.textContent = Math.floor(el);
          if (left <= 10) { sec.textContent += ' / 剩 ' + left + 's'; sec.classList.add('warn'); }
          else sec.classList.remove('warn');
        }
        if (now() - recStart >= VOICE_MAX_MS) stopRecord(true);
      }, 200);
      var bv = $('btnVoice');
      /* E-091-ICON：同上，录音中也用 SVG 而不是 emoji。 */
      if (bv) {
        bv.classList.add('recording');
        bv.innerHTML = '<svg class="ic ic-fill" aria-hidden="true"><use href="#i-stop"/></svg>';
      }
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
     进得去出不来的链条是「误触录音键 → 唯一出口是停止键 → 停止键的作用是发送」。
     取消按钮已补上，但真有人慌了直接按停止键呢？
     录制不足 800ms 视为误触 —— 不发送，直接丢弃并提示。
     （原来 Math.max(1,...) 会把 0.5 秒硬算成 1 秒照样发出去。） */
  var REC_MIN_MS = 800;

  function finishRecord(stream) {
    /* 录音已正常收尾，中途攒的草稿就作废了（S-116）。
       不清理的话，它会一直占着 localStorage 的一块配额，
       而这块空间本来就紧张（localStorage 总共才几 MB）。 */
    try { localStorage.removeItem('wxlg_rec_draft'); } catch (e) { }
    if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { } }
    var tip = $('recTip');
    if (tip) tip.classList.add('hidden');
    var bv = $('btnVoice');
    if (bv) { bv.classList.remove('recording'); bv.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-voice"/></svg>'; }
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
      /* Media.put 现在返回 { ok, reason }：存不住就不能说"已发送"。
         原来无条件提示成功，实际上配额满时音频根本没落盘，
         重启后这条语音变成空的。 */
      return g.Media.put(id, dataUrl).then(function (r) {
        if (!r || r.ok === false) {
          g.UI.toast('语音没能存下来（存储空间不足），没有发送。请先清理旧图片视频。', 'err', 8000);
          return;
        }
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
    /* 主动取消：草稿作废（S-116） */
    try { localStorage.removeItem('wxlg_rec_draft'); } catch (e) { }

    if (!rec) return;
    recChunks = [];
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
    try { rec.stop(); } catch (e) { }
    rec = null;
    var tip = $('recTip'); if (tip) tip.classList.add('hidden');
    var bv = $('btnVoice'); if (bv) { bv.classList.remove('recording'); bv.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-voice"/></svg>'; }
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
        if (!u) { g.UI.toast('这条语音没同步到这台设备'); return; }
        if (!audio) audio = new Audio(u);
        /* E-091-ICON：用 SVG 而不是 emoji。
           textContent 会把 setPlayIcon 写进去的 SVG 整个顶掉，
           播放中变回 emoji，暂停后再变回 SVG —— 同一个按钮两套样子。 */
        play.innerHTML = '<svg class="ic ic-fill" aria-hidden="true"><use href="#i-pause"/></svg>';
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
  /* 把任意用户可控字符串变成安全文件名。
     三件事：去分隔符与非法字符、去控制字符、避开 Windows 保留名。 */
  function safeFileName(name) {
    var s = String(name || '');
    s = s.replace(/[\/\\:*?"<>|]/g, '_');      /* 分隔符与非法字符 */
    s = s.replace(/[\x00-\x1f\x7f]/g, '');       /* 控制字符 */
    s = s.replace(/^[\s.]+/, '');                   /* 开头空白与点（隐藏文件） */
    s = s.replace(/[\s.]+$/, '');                   /* 结尾空白与点（Windows 会吃掉） */
    /* Windows 保留名：CON、PRN、AUX、NUL、COM1-9、LPT1-9（不分大小写，
       且后面带扩展名也不行，如 CON.txt 同样非法） */
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = '_' + s;
    if (!s) s = '未命名';
    /* 长度兜底：文件名过长会被系统截断，截断后可能撞名 */
    if (s.length > 80) s = s.slice(0, 80);
    return s;
  }

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
    /* ⚠ 大房间导出时界面全程零反馈（S-077）。
       数万条消息一次性拼字符串 + 包 Blob 会占住主线程好几秒，
       用户看到的是"点了没反应"，于是反复点 —— 越点越卡。
       所以：① 先显示"正在导出 N 条"；② 让这一帧有机会画出来再干重活。
       分块拼接成本高，这里先解决"看不见进度"这个主要矛盾。 */
    g.UI.toast('正在导出 ' + list.length + ' 条…', 'ok', 0);
    var doExport = function () {
    var blob = new Blob([head + body], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    /* 下载完必须 revoke（S-066）。
       createObjectURL 拿到的 URL 会一直持有 blob 引用，
       不释放的话导出几次大文件，内存就下不来了 ——
       而且这个泄漏不报错，只是越来越卡。 */
    setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) { } }, 60000);
    /* ⚠ 原来只过滤 / : * ? " < > | 这 8 个字符（S-070）。
       房间名是用户可控的，还缺三类：
         ① 反斜杠 \         —— Windows 路径分隔符
         ② 控制字符 \x00-\x1f —— 会让文件名行为异常
         ③ 保留名 CON/PRN/AUX/NUL/COM1..9/LPT1..9 —— Windows 下直接非法
       依赖浏览器自己净化是不可靠的：不同浏览器行为不同，
       而且出错时用户只知道"下载失败"，不知道是房间名的问题。 */
    a.download = safeFileName(r ? r.name : cur) + '-' +
      new Date().toISOString().slice(0, 10) + '.' + (fmt === 'md' ? 'md' : 'txt');
    a.click();
    /* 不必手动 remove：下一次 toast 会复用同一个元素并覆盖内容。
       先移除再新建只是白白多一次 DOM 操作。 */
    g.UI.toast('已导出 ' + list.length + ' 条（'
      + (blob.size / 1024).toFixed(0) + ' KB）', 'ok');
    };
    /* 让"正在导出"这一帧先画出来，再执行重活 */
    setTimeout(doExport, 30);
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
    /* ⚠ 配额原来硬编码 5120 KB（E-087-QUOTA），且从不实测。
       各家浏览器上限并不一致（Chrome/Firefox 约 5MB，Safari 更紧，
       无痕模式可能只有几十 KB）。写死 5120 的后果：
         · 上限实际更小的浏览器里，用户会在**毫无预警**的情况下写满
           —— 而提示要等到"用了 80%"才弹，那时早已写不进去了；
         · 上限更大的浏览器里，白白浪费可用空间。
       实测一次即可（写入配额探测开销很小），测不到再退回 5120。 */
    return { stateKB: Math.round(used / 1024), mediaCount: mediaCount, quotaKB: probeQuotaKB() };
  }

  /**
   * 实测 localStorage 剩余额度。
   *
   * 做法：不断写入递增大小的探测串，直到写失败为止，失败前的量即为上限。
   * 探测串用完立刻删除，不留垃圾。
   * ⚠ 探测本身也可能失败（无痕模式直接禁用），失败就返回保守的 5120，
   *   不能返回 0 或 Infinity —— 那会让"用了百分之多少"的判断失去意义。
   */
  var _quotaCache = null;
  function probeQuotaKB() {
    if (_quotaCache) return _quotaCache;
    var PROBE = 'chat_quota_probe_';
    /* ⚠ 步长取 1MB、最多 10 步，而不是 256KB × 80 步。
       探测是**同步**写入，步进太细会连写几十次把界面卡住 ——
       为了一个显示用的数字卡住主线程不值得。
       精度 1MB 对"用了百分之多少"这个用途已经够了。 */
    var step = 1024 * 1024, max = 10;
    var ok = 0, i;
    try {
      var chunk = new Array(step + 1).join('x');
      for (i = 1; i <= max; i++) {
        localStorage.setItem(PROBE + i, chunk);
        ok = i * step;
      }
    } catch (e) { /* 写满即停，ok 保持上一次成功的值 */ }
    try {
      for (var j = 1; j <= max; j++) localStorage.removeItem(PROBE + j);
    } catch (e) { }
    /* 一次都没写进去 = 存储基本不可用，返回 0 让上层如实告警 */
    _quotaCache = Math.round(ok / 1024) || 0;
    return _quotaCache;
  }

  function checkStorageQuota() {
    var st = storageInfo();
    if (st.stateKB > st.quotaKB * 0.8) {
      /* ⚠ 原来一律指向「站点 → 导出备份」（E-013-BACKUP），而那个入口需要 site.clean 权限。
         普通成员收到一条指向自己够不着的功能的红色 toast，
         且没有任何他能做的事 —— 警告变成了纯骚扰。
         现在按权限分流：够得着就指过去，够不着就给他真能做的动作。 */
      if (g.ACL.can(me, 'site.clean')) {
        g.UI.toast('本地存储已用 ' + st.stateKB + ' KB（约 ' + Math.round(st.quotaKB / 1024)
          + ' MB 上限），建议到「站点」导出备份后清理', 'err', 6000);
      } else {
        g.UI.toast('本地存储已用 ' + st.stateKB + ' KB。重要记录请长按消息复制留存'
          + '——换设备或清浏览器数据会丢失。', 'err', 6000);
      }
    }
  }

  /* ================= 旧媒体清理（先备份再问站长） ================= */
  /* 完整备份：状态 + 媒体本体（E-043 / E-044）。
     ⚠ 原来"导出 JSON"只写 JSON.stringify(S)，
     而 S 里每条消息只有 mediaId —— 媒体在 IndexedDB，根本不进 JSON。
     结果：「先备份再清理」是个假门禁：
       用户照做，导出了，清理了，然后媒体永久没了，备份里也没有。
     ⚠ 更糟的是站点面板还教用户"用导出/导入 JSON 换设备搬运"，
       搬完所有图片视频都变成「没同步到这台设备」——
       用户是按文档操作的，所以他会认为是操作错了，而不是文档错了。

     所以这里导出真正的完整包：媒体以 dataURL 内嵌。
     体积会明显变大（base64 约 1.33 倍），所以先算出来告诉用户。 */
  function buildFullBackup(onProgress) {
    var ids = [];
    Object.keys(S.messages || {}).forEach(function (rid) {
      (S.messages[rid] || []).forEach(function (m) {
        if (m.mediaId && !m.deleted) ids.push(m.mediaId);
      });
    });
    ids = ids.filter(function (v, i) { return ids.indexOf(v) === i; });
    var out = { kind: 'chat-full-backup', version: 2, at: Date.now(), state: S, media: {} };
    var i = 0;
    var step = function () {
      if (typeof onProgress === 'function') onProgress(i, ids.length);
      if (i >= ids.length) return Promise.resolve(out);
      var id = ids[i++];
      return g.Media.get(id).then(function (d) {
        if (d) out.media[id] = d;
      }).catch(function () { }).then(step);
    };
    return step();
  }

  /* 导入完整备份：先还原媒体，再覆盖状态。
     顺序不能反 —— 先写状态的话，界面会先渲染出一堆找不到的媒体。 */
  /* 备份结构校验（S-108，考古补回）。
     原来 restoreFullBackup 直接 `S = obj.state` —— **不检查这份数据长什么样**。
     坏 JSON（截断的文件、别的软件导出的、手改坏的）会被原样写进 S，
     然后整个应用以一个残缺状态跑起来：
     没有 users 就没人能登录，没有 messages 就一片空白，
     而用户看到的是"恢复成功"—— 直到他发现什么都打不开。

     校验要在**写入之前**做，写完再校验就已经污染了。 */
  function backupLooksValid(state) {
    if (!state || typeof state !== 'object') return false;
    if (!Array.isArray(state.users)) return false;
    if (!state.messages || typeof state.messages !== 'object') return false;
    if (!Array.isArray(state.rooms)) return false;
    return true;
  }

  function restoreFullBackup(obj) {
    /* 先校验再动手。不合法就明确拒绝，绝不用坏数据覆盖当前状态。 */
    if (!backupLooksValid(obj && obj.state)) {
      g.UI.toast('这份备份的结构不对（缺少用户、房间或消息数据），已取消恢复，当前数据未改动', 'err', 8000);
      return Promise.resolve(false);
    }
    var media = obj && obj.media || {};
    var ids = Object.keys(media);
    var i = 0;
    var mediaFailed = [];   /* S-096：存不下的媒体 id，末尾要如实报出来 */
    var step = function () {
      if (i >= ids.length) {
        S = obj.state; save(true);
        /* 末尾如实提示：全成功才说「恢复成功」，缺了就说缺了几个 */
        if (mediaFailed.length) {
          g.UI.toast('状态已恢复，但有 ' + mediaFailed.length + ' 个媒体没能存下（共 ' +
            ids.length + ' 个），这些图片视频会显示不出来', 'err', 6000);
        }
        return Promise.resolve(true);
      }
      var id = ids[i++];
      /* ⚠ 存不下必须计数并如实告知（S-096，考古找回）。
         原来这里是个空 catch —— 单个媒体存失败被吞掉，循环继续，
         末尾照样提示「恢复成功」。用户以为全恢复了，
         实际缺了若干图片视频，而且不知道缺了几个、是哪些。

         **备份恢复的最后一句提示必须是真的**，否则它就是个假的完成信号。 */
      return g.Media.put(id, media[id]).catch(function () {
        mediaFailed.push(id);
      }).then(step);
    };
    return step();
  }

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
      '<div class="form-tip danger"><svg class="ic" aria-hidden="true"><use href="#i-warn"/></svg> 必须先导出备份。清理后这些消息的媒体无法显示（消息本身保留）。</div>' +
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
      var tipEl = d.querySelector('#mcTip');
      tipEl.textContent = '正在打包媒体（可能较慢）…';
      /* 用完整备份，别再用 JSON.stringify(S) —— 那个不含媒体，
         照它备份完再清理，媒体就真没了。 */
      buildFullBackup(function (done, total) {
        tipEl.textContent = '正在打包媒体：' + done + ' / ' + total;
      }).then(function (pack) {
        var n = Object.keys(pack.media || {}).length;
        var blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
        var mb = (blob.size / 1048576).toFixed(1);
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) { } }, 60000);
        a.download = 'chat-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        backed = true;
        /* 明确说清备份里包含了什么 —— 用户要能自己确认"真的有媒体"。
           不说的话，他只能相信"备份完成了"这四个字。 */
        d.querySelector('#mcTip').innerHTML =
          '<svg class="ic" aria-hidden="true"><use href="#i-check"/></svg> ' +
          '备份已下载（含 ' + n + ' 个媒体文件，' + mb + ' MB），现在可以执行清理了。';
        log('backup', '清理前导出完整备份（含 ' + n + ' 个媒体）');
      }).catch(function (e) {
        tipEl.textContent = '备份失败：' + (e && e.message ? e.message : '未知错误');
        g.UI.toast('备份失败，未执行清理', 'err');
      });
    };
  }

  /* ================= 邀请口令 =================
   * 群主/管理员生成一次性口令（可设有效期与使用次数），
   * 别人在房间列表输入口令即可入群，无需逐个邀请。
   */
  function genCode() {
    /* 与服务端保持一致：小写（INV-CASE）。
       原来前端大写、服务端也大写，改小写后两边必须一起改，
       否则同一条口令在两台设备上长得不一样。 */
    var cs = 'abcdefghjkmnpqrstuvwxyz23456789';
    var r = '';
    for (var i = 0; i < 6; i++) r += cs.charAt(Math.floor(Math.random() * cs.length));
    return r;
  }

  /* 展示生成的口令。抽成函数是因为在线/本机两条路径都要用，
     写两份迟早对不上（一份改了另一份没改）。 */
  function showCode(box, code, h, u) {
    if (!box) return;
    box.innerHTML = '<div class="invite-code">' + code + '</div>' +
      '<div class="field-hint">有效期：' + (h > 0 ? h + ' 小时' : '长期') +
      ' · 可用 ' + (u > 0 ? u + ' 次' : '不限次数') + '</div>' +
      '<button class="btn ghost" id="icCopy">复制口令</button>';
    var cb = box.querySelector('#icCopy');
    if (cb) cb.onclick = function () {
      /* 同上（E-090）。口令复制失败尤其要给出原文 ——
         口令是给用户手动转述用的，复制失败必须让他能直接看到。 */
      copyText(code, '复制失败，请手动记下：' + code);
    };
  }

  /* 能不能邀请别人：默认能（群聊里互相拉人是常态），
     除非被管理员单独关掉。房主与房间管理员不受限制。 */
  function canInvite(u, r) {
    if (!u || !r) return false;
    if (r.owner === u.id || (r.admins || []).indexOf(u.id) >= 0) return true;
    if (u.role === 'owner' || u.role === 'admin') return true;
    return ((r.noInvite || []).indexOf(u.id) < 0);
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
      /* ⚠ 自定义口令（INV-CUSTOM）。
         随机码 A7K2M9 这种**口头传达极其费劲**：要一个字母一个字母念，
         对方还要反复确认"是 B 还是 D"。而邀请大量发生在当面或电话里。
         所以给有权限的人一个选项：自己指定一个好说好记的词。

         只对有权限的人显示 —— 普通成员看不到这个框，
         而不是让他填了再被服务端拒绝（那样只会让人困惑）。 */
      (canCustomCode(r)
        ? '<label class="field-label">自定义口令（可选）</label>' +
          '<input class="field" id="icCustom" placeholder="留空则自动生成，如：welcome" maxlength="24">' +
          '<div class="field-hint" id="icCustomHint">字母和数字，3~24 位。' +
          '不要用 0/1/i/l/o —— 口头传达最容易听错。好记的优先，别追求复杂。</div>'
        : '') +
      '<div id="icOut" class="invite-out"></div>' +
      /* ⚠ 必须能看见已生成的口令（E-089，考古补回）。
         原来生成完就只剩一个输入框，没有任何地方列出"我发过什么"。
         生成一个「长期有效 · 不限次数」的口令后，**再也收不回来**。
         看不见的东西，自然也就没法作废 —— inviteRevoke 零处调用正是因为这个。 */
      '<div class="sec-title" style="margin-top:12px"><span>已生成的口令</span>' +
      '<button class="mini-btn" id="icRefresh">刷新</button></div>' +
      '<div id="icList" class="invite-list"><div class="empty-tip">加载中…</div></div>';
    g.UI.modal({
      title: '生成邀请口令 · ' + r.name, body: d, okText: '生成', onOk: function (body) {
        var h = parseInt(body.querySelector('#icHour').value, 10);
        var u = parseInt(body.querySelector('#icUse').value, 10);
        var out0 = body.querySelector('#icOut');
        /* 在线模式：口令必须建在服务端，否则换台设备就"不存在"。
           这里改成异步，所以先占位提示，拿到再显示。 */
        if (g.Online && g.Online.isOnline && g.Online.isOnline()) {
          out0.textContent = '正在生成…';
          var cbox = body.querySelector('#icCustom');
          var custom = cbox ? String(cbox.value || '').trim() : '';
          g.Online.inviteCreate(r.id, h, u, custom).then(function (res) {
            var code = res && res.code;
            if (!code) throw new Error('服务端未返回口令');
            log('invite', '为「' + r.name + '」生成邀请口令（服务端）');
            showCode(out0, code, h, u);
          }).catch(function (e) {
            /* 服务端会明确报"你的邀请权限已被管理员关闭"，必须显示出来 */
            out0.textContent = '生成失败：' + (e && e.message ? e.message : '网络错误');
            g.UI.toast('生成失败：' + (e && e.message ? e.message : '网络错误'), 'err');
          });
          return false;
        }
        var code = genCode();
        S.invites = S.invites || [];
        S.invites.push({
          code: code, room: r.id, by: me.id,
          expireAt: h > 0 ? serverNowSafe() + h * 3600000 : 0,
          maxUse: u, used: 0, createdAt: Date.now()
        });
        save();
        var out = body.querySelector('#icOut');
        showCode(out, code, h, u);
        log('invite', '为「' + r.name + '」生成邀请口令（本机）');
        renderInviteList(body.querySelector('#icList'), r);
        return false;   /* 保持弹窗打开，便于看到口令 */
      },
      onOpen: function (body) {
        var lf = body.querySelector('#icRefresh');
        if (lf) lf.onclick = function () { renderInviteList(body.querySelector('#icList'), r); };
        renderInviteList(body.querySelector('#icList'), r);
        /* 实时提示（本次新增）：不是硬拒绝，而是提前告诉你哪个字会听错。
           硬拒绝只会让人烦；他要真想用 0，那是他的选择 ——
           但至少要知道自己在承担什么。 */
        var cb = body.querySelector('#icCustom');
        var hint = body.querySelector('#icCustomHint');
        /* 自定义 + 长期有效 = 这个词会被一直占住（INV-RELEASE）。
           好记的词是稀缺的，占住了别人就不能用 ——
           得让人知道自己在做什么，而不是等别人来报"welcome 用不了"。 */
        var hs = body.querySelector('#icHour');
        if (hs && hint) hs.addEventListener('change', function () {
          if (cb && String(cb.value || '').trim() && hs.value === '0' && hint) {
            hint.className = 'field-hint warn';
            hint.textContent = '自定义口令设成"长期有效"会一直占用这个词，'
              + '别人以后就无法再用它了（除非你手动作废）。建议设个期限。';
          }
        });
        if (cb && hint) cb.addEventListener('input', function () {
          var v = String(cb.value || '').trim().toLowerCase();
          if (!v) { hint.className = 'field-hint'; hint.textContent = '字母和数字，3~24 位。不要用 0/1/i/l/o —— 口头传达最容易听错。好记的优先，别追求复杂。'; return; }
          var bad = (v.match(/[01ilo]/g) || []);
          if (bad.length) {
            hint.className = 'field-hint warn';
            hint.textContent = '含有容易听错的「' + bad.join(' ') + '」，对方可能记错。建议换掉。';
          } else if (v.length < 3) {
            hint.className = 'field-hint'; hint.textContent = '至少 3 位。';
          } else if (!/^[a-z0-9]+$/.test(v)) {
            hint.className = 'field-hint warn';
            hint.textContent = '只能包含字母和数字，不能有空格、符号或汉字。';
          } else {
            hint.className = 'field-hint ok';
            hint.textContent = '可用。对方输入时不区分大小写。';
          }
        });
      }
    });
  }

  /* 谁能设置自定义口令（INV-CUSTOM）。
     服务端口径是：房主 / 房间管理员 / 站长 / 全站管理员。
     这里必须与服务端**完全一致**，否则会出现"界面上有框、提交被拒"。

     ⚠ 试运行口径（2026-10-13）：范围按"先跑起来看"定的，
     还没定死。"大群群主"这条要等想清楚群规模怎么算（人数？活跃度？），
     没猜。等实测有人需要但够不着，再放。 */
  function canCustomCode(r) {
    if (!me) return false;
    if (me.role === 'owner' || me.role === 'admin') return true;
    if (!r) return false;
    if (r.owner === me.id) return true;
    return (r.admins || []).indexOf(me.id) >= 0;
  }

  /* 已生成口令列表（E-089）。
     重点是"长期·不限次数"那类要醒目标出来 —— 它是最该被收回、
     也最容易彻底忘掉的。已作废的也列出来，标上作废时间。 */
  function renderInviteList(el, r) {
    if (!el) return;
    if (!g.Online || !g.Online.isOnline || !g.Online.isOnline() || !g.Online.inviteList) {
      el.innerHTML = '<div class="empty-tip">离线模式下口令只存在本机，暂无列表</div>';
      return;
    }
    el.innerHTML = '<div class="empty-tip">加载中…</div>';
    g.Online.inviteList().then(function (rows) {
      var arr = rows || [];
      if (!arr.length) { el.innerHTML = '<div class="empty-tip">还没有生成过口令</div>'; return; }
      el.innerHTML = '';
      arr.forEach(function (it) {
        var row = elc('div', 'invite-row' + (dead ? ' revoked' : ''));
        var longLive = !it.expire_at && (!it.max_use || it.max_use === 0);
        /* 失效 = 作废 / 过期 / 次数用完（INV-RELEASE）。
           失效的口令**不再占用名字**，别人可以重新用这个词 ——
           这点必须在界面上说出来，否则生成者会以为它永远占着。 */
        var expired = it.expire_at && new Date(it.expire_at).getTime() < Date.now();
        var usedUp = it.max_use > 0 && it.used >= it.max_use;
        var dead = !!(it.revoked_at || expired || usedUp);
        var stat = it.revoked_at ? '已作废'
          : expired ? '已过期'
          : usedUp ? '次数已用完'
          : (it.max_use && it.max_use > 0 ? ('已用 ' + it.used + ' / ' + it.max_use + ' 次') : ('已用 ' + it.used + ' 次'));
        row.innerHTML =
          '<div class="ir-top"><code>' + g.UI.esc(it.code) + '</code>' +
          '<span class="tag' + (dead ? '' : (longLive ? ' orange' : ' gray')) + '">' + g.UI.esc(stat) + '</span>' +
          (dead ? '<span class="tag gray">名字已释放</span>' : '') +
          (longLive && !dead ? '<span class="tag red">长期·不限次数</span>' : '') + '</div>' +
          '<div class="ir-sub">' + g.UI.esc(it.room_name || it.room_id) +
          ' · ' + (it.expire_at ? ('到期 ' + g.UI.fmtTime(new Date(it.expire_at).getTime())) : '长期有效') +
          (it.revoked_at ? ' · 作废于 ' + g.UI.fmtTime(new Date(it.revoked_at).getTime()) : '') + '</div>';
        if (!dead) {
          var b = elc('button', 'mini-btn danger', '作废');
          b.onclick = function () {
            g.UI.confirm('作废口令 ' + it.code + '？作废后对方将无法再用它加入。', function () {
              g.Online.inviteRevoke(it.code).then(function () {
                g.UI.toast('已作废', 'ok');
                renderInviteList(el, r);
              }).catch(function (e) {
                g.UI.toast('作废失败：' + ((e && e.message) || '网络错误'), 'err');
              });
            });
          };
          row.appendChild(b);
        }
        el.appendChild(row);
      });
    }).catch(function (e) {
      el.innerHTML = '<div class="empty-tip">加载失败：' + g.UI.esc((e && e.message) || '网络错误') + '</div>';
    });
  }

  /* 用口令加入房间 */
  function joinByCode() {
    var d = elc('div', '');
    d.innerHTML =
      /* maxlength 从 6 放宽到 24：自定义口令最长 24 位。
         不改的话，自定义口令在这个框里会被**截断**，怎么输都不对，
         而用户只会以为口令错了，想不到是输入框把它截短了。 */
      '<label class="field-label">邀请口令</label><input class="field" id="jcCode" placeholder="口令，如 welcome" maxlength="24">' +
      '<div id="jcMsg" class="field-hint"></div>';
    g.UI.modal({
      title: '用口令加入房间', body: d, okText: '加入', onOk: function (body) {
        /* 不再 toUpperCase：自定义口令是小写，大小写兼容交给服务端。 */
        var c = (body.querySelector('#jcCode').value || '').trim();
        if (!c) { g.UI.toast('请输入口令'); return false; }
        var tip = body.querySelector('#jcMsg');

        /* 在线：走服务端兑换。
           本地那份 S.invites 是别人机器上的，本机压根看不到。 */
        if (g.Online && g.Online.isOnline && g.Online.isOnline()) {
          tip.textContent = '正在验证…';
          g.Online.inviteRedeem(c).then(function (res) {
            var rid = res && res.room;
            if (!rid) throw new Error('服务端未返回房间');
            joinRoom(rid, me, true);
            /* 成员表在服务端已改，拉一次增量让界面跟上 */
            return g.Online.pull().then(function (inS) {
              if (inS && mergeState(inS)) save(true);
            }).then(function () {
              openRoom(rid);
              g.UI.toast('已加入「' + ((res && res.name) || rid) + '」', 'ok');
            });
          }).catch(function (e) {
            /* 这些提示都是用户要照着行动的判断，不能吞 */
            tip.textContent = (e && e.message) ? e.message : '加入失败';
          });
          return false;
        }

        var inv = (S.invites || []).filter(function (x) { return x.code === c; })[0];
        if (!inv) { tip.textContent = '口令不存在或已失效'; return false; }
        /* 同上：expireAt 是服务端时间戳，用本机钟比会提前/延后失效 */
        if (inv.expireAt && inv.expireAt < serverNowSafe()) { tip.textContent = '口令已过期'; return false; }
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
        /* ⚠ 必须过滤"我是否还是这个房间的成员"（E-059） */
        if (!canSeeRoom(rid)) return;
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
      /* ⚠ 原来只写"共 N 条"，然后 slice(0, 60) 悄悄截断。
         N=800 时用户看到的仍是 60 条，而提示说 800 ——
         他会以为搜索坏了（"明明说有 800 条，怎么只有 60 条？"），
         或者以为漏了什么。**截断了就必须说清楚截断了。** */
      var SHOWN = Math.min(hits.length, 60);
      var tip = elc('div', 'field-hint', hits.length > SHOWN
        ? ('共 ' + hits.length + ' 条，先显示最新 ' + SHOWN + ' 条（按时间倒序）；换个更具体的词可以缩小范围')
        : ('共 ' + hits.length + ' 条，按时间倒序'));
      box.appendChild(tip);
      hits.slice(0, SHOWN).forEach(function (h) {
        var it = elc('div', 'search-item');
        var u = findUser(h.m.from);
        var rn = findRoom(h.rid);
        it.innerHTML = '<div class="search-meta">' + g.UI.esc(u ? u.nick : '未知') +
          ' · ' + g.UI.esc(rn ? rn.name : h.rid) + ' · ' + g.UI.fmtFull(h.m.ts) + '</div>' +
          '<div class="search-body">' + g.UI.esc(h.txt.slice(0, 120)) + '</div>';
        /* ⚠ 原来只等 200ms 找一次节点，找不到就**什么都不做**（S-078）。
           渲染只画最近 MSG_PAGE(300) 条，搜到的常常是更早的消息 ——
           节点根本不在 DOM 里。
           表现：点搜索结果，房间切换了，但没跳到那条消息，
           界面毫无提示，用户以为"点错了"或"搜索坏了"。

           改成：找不到就继续往上翻页再找，最多翻到全部载入；
           真的找不到（比如消息已被删除）也要说一句，不能无声。 */
        it.onclick = function () {
          openRoom(h.rid);
          var tries = 0;
          (function locate() {
            var nd = document.querySelector('[data-mid="' + h.m.id + '"]');
            if (nd) {
              nd.scrollIntoView({ block: 'center' });
              nd.classList.add('flash');
              setTimeout(function () { nd.classList.remove('flash'); }, 1200);
              return;
            }
            var total = ((S.messages && S.messages[h.rid]) || []).length;
            if (tries++ < 20 && MSG_PAGE < total) {
              MSG_PAGE += 300;
              renderChat();
              setTimeout(locate, 30);
              return;
            }
            g.UI.toast('已切到该会话，但没能定位到这条消息（可能已被撤回或删除）', 'err', 4000);
          })();
        };
        box.appendChild(it);
      });
    };
    /* ⚠ 原来 oninput 直接跑（S-076）：每敲一个字就遍历所有房间的所有消息。
       房间多、消息多的时候，打字会明显卡顿，
       而用户感知到的只是"这个软件很卡"，不会想到是搜索。
       加 180ms 防抖：人打字的间隔通常大于这个数，
       所以看起来仍是"边打边出结果"，但扫描次数少一个数量级。 */
    var swTimer = null;
    d.querySelector('#swK').oninput = function () {
      if (swTimer) clearTimeout(swTimer);
      swTimer = setTimeout(run, 180);
    };
    /* ⚠ 防抖只加在关键词框上了，发送者框还是 oninput 直接跑 ——
       同样是全量扫描，只是触发频率低一些，卡顿照样存在。
       两个框共用同一个防抖：任一输入都重新计时。 */
    d.querySelector('#swWho').oninput = function () {
      if (swTimer) clearTimeout(swTimer);
      swTimer = setTimeout(run, 180);
    };
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
        /* ⚠ 表情格子原来只有图形内容（S-110）。
           屏幕阅读器会直接念出这个字符（比如"露出牙齿的笑脸"），
           一屏几十个格子连着念，等于噪音；
           而用键盘 Tab 过去时更是完全不知道焦点在哪。
           补 aria-label 说明"这是插入表情的按钮"，并让图形本身对读屏器隐藏。 */
        b.setAttribute('aria-label', '插入表情');
        b.setAttribute('role', 'button');
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
        /* 同上：符号格子也要让读屏器知道这是什么。
           这里用 it[0]（符号名，如「箭头」）比念符号本身有用得多。 */
        b.setAttribute('aria-label', '插入符号：' + g.UI.esc(it[0]));
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
      g.UI.toast('已同步到云端，换设备可见', 'ok');
      /* 回填到服务端消息记录，其他设备才能知道去哪取 */
      /* 走封装，别直接 g.SB.rpc。
         原来这里 .catch(function () { })，回填失败完全无声 ——
         消息看着有图，别的设备打开却是空的。 */
      if (g.Online && g.Online.msgMedia) {
        g.Online.msgMedia(m.id, slot.path).catch(function (e) {
          g.UI.toast('媒体回填失败：' + (e && e.message ? e.message : '网络错误'), 'err');
        });
      }
      save(true);
    }).catch(function (e) {
      /* 降级不静默：这条消息在本机看得到、换设备看不到，得让人知道 */
      g.UI.toast('已发送（本机可见），云端上传失败：' + ((e && e.message) || '未知原因'), 'err');
    });
  }

  /* ⚠ 第三个参数 roomId（S-109）：**把目标房间固定下来**。
     原来只用全局 cur，而批量发图是 `setTimeout(..., i * 350)` 逐个发的 ——
     发到第 3 张时用户切了房间，第 4 张就飞到新房间去了。
     消息发错房间是所有 bug 里最严重的一类：
     它可能把发给 A 的图送到了 B 那儿，而发的人浑然不觉。
     所以调用方必须把"发起时的房间"显式传进来，不能依赖回调执行时的 cur。 */
  function sendMediaFile(file, kind, roomId) {
    var rid = roomId || cur;
    var r = findRoom(rid);
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
        return g.Media.put(id, u).then(function (r) {
          /* 存不住就别发 —— 发了也是一条打不开的空消息，
             而且对方看到的是"有个文件"，点开却什么都没有，
             比直接告诉他没发出去更困惑。 */
          if (!r || r.ok === false) {
            g.UI.toast('文件没能存下来（存储空间不足），没有发送。请先清理旧图片视频。', 'err', 8000);
            return null;
          }
          var m = {
            id: uid('msg'), room: rid, from: me.id, type: kind,
            mediaId: id, name: file.name, size: g.Media.dataUrlSize(u), ts: now()
          };
          return (kind === 'video'
            ? g.Media.videoPoster(u).then(function (p) { if (p) m.poster = p; return m; })
                .catch(function () { return m; })
            : Promise.resolve(m)).then(function (mm) {
              /* 上一步存不住时传下来的是 null —— 必须挡住，
                 否则下面读 mm.room 直接抛 TypeError，
                 变成一个"点发送没反应"的诡异现象。 */
              if (!mm) return null;
              /* ⚠ 离线时原来什么都不做，只 toast「已发送」（E-055）。
                 结果：图片/视频/语音/文件**永远只在自己这台设备上**，
                 联网后也不会补发，对方一条都收不到，
                 而本机看着是"已发送" —— 用户完全不知道没发出去。

                 所以离线也要入队。队列里放 mediaId（不放大段 dataUrl：
                 localStorage 总共 5 MB，存不下图片），
                 补发时再按 id 从 IndexedDB 取回本体上传。 */
              if (g.Online && g.Online.isOnline() && g.Online.isOnline()) {
                uploadRemote(mm, u);
              } else if (g.Online && g.Online.enqueue) {
                var res = g.Online.enqueue({
                  room: mm.room, type: mm.type, localId: mm.id,
                  mediaId: mm.mediaId, name: mm.name || '', size: mm.size || 0
                });
                /* 存不下要如实说，不能照样显示"已发送" */
                if (!res.ok) {
                  mm.pending = false;
                  g.UI.toast('待发送队列已满，这条媒体只存在本机', 'err', 5000);
                } else {
                  mm.pending = true;
                }
              }
              return mm;
            });
        });
      });
    }).then(function (m) {
      /* 存不住时是 null，不能 pushMsg(null) —— 会往房间塞一条空消息 */
      if (!m) return;
      pushMsg(m);
      /* 在线模式下先说「已发送（本机）」。
         上传是异步的、不等结果，几秒后才可能弹「云端上传失败」——
         如果第一条直接说「已发送」，用户会看到一绿一红自相矛盾，
         不知道到底发出去没有。 */
      var onl = !!(g.Online && g.Online.isOnline());
      /* 离线：说清"待联网后补发"，别只说"已发送" ——
         后者会让用户以为对方已经收到了。 */
      g.UI.toast(onl ? '已发送（本机），正在同步到云端…'
        : (m.pending ? '已加入待发送队列，联网后自动补发' : '已保存到本机（未加入队列）'), 'ok');
    })
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
      case 'nick': {
        if (!rest.trim()) { g.UI.toast('用法：/nick 新昵称'); return; }
        var nn2 = rest.trim();
        /* ⚠ 原来只改本地（S-061）：在线模式下刷新即回滚，
           其他设备完全不知道，而界面已经弹了"修改了昵称"。
           **说了改了却没改，比不支持更糟** ——
           用户会以为别人看到的是新昵称，其实别人看到的还是旧的。
           服务端 profile_update 一直存在，只是没接。 */
        if (g.Online && g.Online.isOnline() && g.Online.profileUpdate) {
          g.Online.profileUpdate({ nick: nn2 }).then(function () {
            me.nick = nn2; touch(me);
            sysMsg(cur, '「' + nn2 + '」修改了昵称'); save();
          }).catch(function (e) {
            /* 改名失败必须说清楚，尤其是"昵称已被占用" ——
               不说的话用户会以为改成了，其实还是旧名字。 */
            g.UI.toast('修改昵称失败：' + (e && e.message ? e.message : '网络错误'), 'err');
          });
        } else {
          me.nick = nn2; touch(me);
          sysMsg(cur, '「' + nn2 + '」修改了昵称'); save();
        }
        return;
      }
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
        /* ⚠ 这条（以及下面 ban/unban/admin/transfer 等）目前只改本地（S-061）。
           在线模式下刷新就回滚、其他设备看不到 ——
           而系统消息已经播了"修改了公告"，等于承诺了没兑现。
           逐个接服务端是下一轮的事；
           **但在接之前，不能假装同步成功** —— 所以在线模式下明确告知。 */
        var onl2 = !!(g.Online && g.Online.isOnline && g.Online.isOnline());
        r.notice = rest; touch(r); log('notice', '修改公告', r.id); save();
        if (onl2) g.UI.toast('公告只改了本机，其他设备暂不会同步', 'err', 5000);
        return;
      }
      case 'mute': {
        var p = rest.split(/\s+/).filter(Boolean), u2 = byNick(p[0] || '');
        /* ⚠ 作用域参数：默认本群，显式写 all / 全站 才全站禁言。
           不加这个参数的话，站长想全站禁言就只能去用户卡片里点 ——
           而在聊天框里敲命令是最顺手的路径，不该把这条路堵死。 */
        var scopeAll = false, argI = 1;
        for (var pi = 1; pi < p.length; pi++) {
          var a = String(p[pi]).toLowerCase();
          if (a === 'all' || a === '全站' || a === 'global') { scopeAll = true; p.splice(pi, 1); break; }
        }
        if (!u2) { g.UI.toast('用法：/mute @昵称 [分钟] [all=全站]，默认禁言本群'); return; }
        /* ⚠ 全站禁言必须走**全站级**权限，不能带房间判（本次考古发现）。
           带房间时 can() 会走到「群主/群管理员在自己房间的固有权力」那条，
           而 ROOM_INHERENT 里含 user.mute ——
           于是**群主在自己群里就拥有了全站禁言的权力**，这是权限提升。

           不带 room 参数，那条房间固有权力就不会命中。
           群内禁言仍走带房间的判定（群主管本群，天经地义）。（S-112） */
        if (scopeAll && !g.ACL.can(me, 'user.mute')) {
          g.UI.toast('全站禁言需要管理员及以上权限，群主只能禁言本群', 'err'); return;
        }
        if (!scopeAll && !g.ACL.can(me, 'user.mute', r)) { g.UI.toast('没有禁言权限', 'err'); return; }
        var min = parseInt(p[1] || '10', 10) || 10;
        if (g.ACL.roomRole(u2, r) === 'roomAdmin' && g.ACL.roomRole(me, r) !== 'roomOwner' && me.role !== 'owner') { g.UI.toast('不能禁言同级管理员', 'err'); return; }
        /* ⚠ 在群里 /mute 只应禁言这个群，不该全站禁言（E-068/E-069，考古补回）。
           原来设的是 u2.mutedUntil（users 表的全站禁言），
           而 canSpeak 里 muted(user) 不区分房间 —— 此人此后在所有房间都不能说话。
           用户是在某个群里操作的，语义上就是"在这个群别说了"。

           同时 room.muted 这个数组建好了却**零处 push**（只在建房间时初始化为 []），
           等于群内禁言功能两端都备好、中间没接上，从未生效过。
           这里一并接上。 */
        if (scopeAll) {
          /* 全站禁言：写 users.mutedUntil 并同步服务端 */
          u2.mutedUntil = now() + min * 60000; touch(u2); syncMute(u2, min);
          sysMsg(cur, '「' + u2.nick + '」被全站禁言 ' + min + ' 分钟');
          log('mute', u2.nick + ' ' + min + '分钟（全站）', r.id);
          save(); renderChat(); return;
        }
        /* ⚠ 群内禁言必须调服务端（S-113）。
           只 push 本地 room.muted 是"假禁言"：换设备就没、
           被禁者自己改一下就解了、服务端根本不知道有过这次处置。 */
        r.roomMuted = r.roomMuted || {};
        r.roomMuted[u2.id] = now() + min * 60000;
        touch(r);
        sysMsg(cur, '「' + u2.nick + '」在本群被禁言 ' + min + ' 分钟');
        log('mute', u2.nick + ' ' + min + '分钟（本群）', r.id);
        save(); renderChat();
        if (g.Online && g.Online.isOnline() && g.Online.setRoomMute) {
          g.Online.setRoomMute(r.id, u2.id, min).catch(function (e) {
            /* ⚠ 回滚只能**还原原值**，不能"算"出新值（S-112）。
               原来失败时算成 now()+600000，于是解除失败反而加了 10 分钟。 */
            delete r.roomMuted[u2.id];
            save(true); renderChat();
            g.UI.toast('禁言失败：' + ((e && e.message) || '网络错误'), 'err');
          });
        }
        return;
      }
      case 'unmute': {
        var p3 = rest.split(/\s+/).filter(Boolean);
        var u3 = byNick(p3[0] || '');
        /* 与 /mute 对称：all 表示解除全站禁言，默认解除本群 */
        var unAll = false;
        for (var pj = 1; pj < p3.length; pj++) {
          var a3 = String(p3[pj]).toLowerCase();
          if (a3 === 'all' || a3 === '全站' || a3 === 'global') { unAll = true; break; }
        }
        if (!u3) { g.UI.toast('用法：/unmute @昵称 [all=全站]'); return; }
        /* 同上：解除**全站**禁言同样要全站级权限（S-112）。
           否则群主在自己群里 /unmute @某人 all，就能解掉站长设的全站禁言。
           群内解除只需房间级权限。 */
        if (unAll && !g.ACL.can(me, 'user.mute')) {
          g.UI.toast('解除全站禁言需要管理员及以上权限', 'err'); return;
        }
        if (!unAll && !g.ACL.can(me, 'user.mute', r)) { g.UI.toast('没有禁言权限', 'err'); return; }
        if (unAll) {
          u3.mutedUntil = 0; touch(u3); syncMute(u3, 0);
          sysMsg(cur, '「' + u3.nick + '」的全站禁言已解除');
          log('unmute', u3.nick + '（全站）', r.id); save(); renderChat(); return;
        }
        /* 同上：本群解禁也要走服务端，且要一并清本地老数组（E-068）。 */
        var hadMute = r.roomMuted && r.roomMuted[u3.id];
        r.roomMuted = r.roomMuted || {};
        delete r.roomMuted[u3.id];
        r.muted = (r.muted || []).filter(function (x) { return x !== u3.id; });
        touch(r);
        sysMsg(cur, '「' + u3.nick + '」在本群的禁言已解除');
        log('unmute', u3.nick + '（本群）', r.id); save(); renderChat();
        if (g.Online && g.Online.isOnline() && g.Online.setRoomMute) {
          g.Online.setRoomMute(r.id, u3.id, 0).catch(function (e) {
            if (hadMute) r.roomMuted[u3.id] = hadMute;   /* 还原原值，不新算 */
            save(true); renderChat();
            g.UI.toast('解除失败：' + ((e && e.message) || '网络错误'), 'err');
          });
        }
        return;
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
          /* ⚠ 清空只清本地（E-080）：其他人的历史一条没少。
             管理员看到"消息已清空"会以为全站都清了 ——
             这是最需要说清的一类：他做的是一个**以为生效、实际只对自己生效**的操作。 */
          if (g.Online && g.Online.isOnline && g.Online.isOnline()) {
            g.UI.toast('只清空了本机，其他成员的历史未受影响', 'err', 6000);
          }
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
        /* ⚠ 原来判的是 role（owner/admin），而权限表里明明有 sys.notice 这一项，
           管理员面板也能逐项勾选它。
           结果：**站长把某个管理员的「发布全站公告」关掉，
           他照样能发** —— 界面上显示已收回，实际没生效。
           这和 acl.js 开头写的原则直接冲突：
           "管理员只是称号，能做什么完全由逐项勾选决定"。
           收回了却还有效，比一开始就不给这个开关更糟，
           因为站长以为已经收回去了，不会再盯。 */
        if (!g.ACL.can(me, 'sys.notice')) { g.UI.toast('没有发布全站公告的权限', 'err'); return; }
        S.rooms.forEach(function (x) { sysMsg(x.id, '【系统公告】' + rest); });
        log('sys', rest); save(); return;
      }
      case 'env':
        /* 同理：权限表里有 sys.env，但原来谁都能跑。 */
        if (!g.ACL.can(me, 'sys.env')) { g.UI.toast('没有查看运行环境的权限', 'err'); return; }
        envModal(); return;
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
      ['/mute @昵称 [分钟]', '在本群禁言（默认 10 分钟）'],
      ['/mute @昵称 分钟 all', '全站禁言（加 all 才生效）'],
      ['/unmute @昵称', '解除本群禁言'],
      ['/unmute @昵称 all', '解除全站禁言'],
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
      /* ⚠ S.seq 原来**全项目没有任何一处读它**（S-086）。
         save() 里每次 +1，但没人看 —— 纯粹是死计数器。

         死代码最坏的地方不是占几字节，是**误导**：
         后来者看到"有个 seq 在递增"，会以为存在基于它的写入冲突检测，
         于是放心地不去查真正的冲突处理 —— 而那个其实并不存在。

         所以给它一个真实用途而不是放着：显示在这里作为诊断信息。
         它确实有用 —— 两个标签同时开着，各自的 seq 不同步增长，
         一眼就能看出"这份状态被几个地方写过、写到第几次了"。 */
      ['状态写入次数（seq）', S.seq || 0],
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
    /* 切房间时要清掉的跨房间状态。两处，都是模块级变量，
       不清就会从一个房间"漏"到另一个房间：

       1) MSG_PAGE 翻页数 —— 在 A 翻到 3000 条，切到消息多的 B
          会一口气渲染几千条，首屏直接卡死。
       2) replyTo 回复引用 —— 在 A 选了条消息点回复，切到 B 后
          回复条还挂着，发出去就变成"B 房间里回复 A 某人"，
          而那个人根本不在这个房间。 */
    if (cur !== rid) {
      MSG_PAGE = 300;
      replyTo = null;
      var rb = $('replyBar');
      if (rb) { rb.classList.add('hidden'); rb.innerHTML = ''; }
    }
    if (!r) return;
    if (r.pwd && r.members && r.members.indexOf(me.id) < 0) {
      g.UI.prompt('需要群密码', '请输入「' + r.name + '」的进入密码', '', function (v) {
        /* 在线时密码必须交给服务端校验。
           本地校验在这里必然失败：online.js 的 tRoom() 把 pwd 转成了
           字符串 '(已设置)'（在线模式下 salt/hash 本来就不下发），
           而 verifyPwd 要的是 {salt,hash} 对象 ——
           结果是输对密码也提示"密码错误"，房间永远进不去。 */
        if (g.Online && g.Online.isOnline && g.Online.isOnline() && g.Online.joinRoom) {
          g.Online.joinRoom(rid, v).then(function () {
            cur = rid; unread[rid] = 0; atMe[rid] = 0; syncBadge();
            renderAll(); scrollBottom();
          }, function (e) {
            g.UI.toast('密码错误' + (e && e.message ? '：' + e.message : ''), 'err');
          });
          return;
        }
        var rv = verifyPwd(v, r.pwd.salt, r.pwd.hash);
        if (!rv.ok) { g.UI.toast('密码错误', 'err'); return; }
        if (rv.legacy) { r.pwd.hash = hashPwd(v, r.pwd.salt); save(); }
        joinRoom(rid, me); save(); cur = rid; unread[rid] = 0; atMe[rid] = 0; syncBadge(); renderAll(); scrollBottom();
      }, { password: true });
      return;
    }
    cur = rid; unread[rid] = 0; atMe[rid] = 0; syncBadge();
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
        /* ⚠ 原来找不到昵称就静默跳过（E-048）。
           填「小明,小红」结果一个人都没进来，界面什么也不说 ——
           用户会以为建群成功了、人也在里面，
           直到发现群里只有自己，还得一个个重新加。
           本条曾被 ghpull 覆盖丢失，故重新应用。 */
        var notFound = [];
        cMem.value.split(/[,，\s]+/).forEach(function (n) {
          if (!n) return;
          var u = byNick(n);
          if (!u) { notFound.push(n); return; }
          if (r.members.indexOf(u.id) < 0) r.members.push(u.id);
        });
        /* 不因此阻断建群：群名等其他信息都填好了，
           因为一个昵称拼错就全部作废更烦。建完提示即可。 */
        if (notFound.length) {
          setTimeout(function () {
            g.UI.toast('以下昵称没找到，未加入：' + notFound.join('、'), 'err', 6000);
          }, 300);
        }
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
                  if (!u) { failed.push(n); return; }   /* 昵称不存在也要报出来 */
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
    /* 免打扰是本地偏好，不进服务端判定：它只影响"我这边提不提醒"，
       不影响消息送达，也不影响别人。 */
    items.push([(g.Notifier && g.Notifier.roomMuted(r.id)) ? '已免打扰' : '免打扰此会话',
      function () {
        if (!g.Notifier) { g.UI.toast('通知模块未加载', 'err'); return; }
        g.Notifier.setRoomMuted(r.id, !g.Notifier.roomMuted(r.id));
        g.UI.toast(g.Notifier.roomMuted(r.id) ? '已开启免打扰（仍会收到消息，只是不提醒）' : '已关闭免打扰', 'ok');
        renderSidebar(); renderDndTip();
      }]);
    if (g.ACL.can(me, 'room.manage', r)) {
      /* 「生成邀请口令」入口：默认给成员，但被单独禁掉的看不到。
         藏起来比"点了报权限不足"好 ——
         但真正的闸门在服务端 invite_create()，藏只是省一次点击。 */
      if (canInvite(me, r)) {
        items.push(['生成邀请口令', function () { inviteCodeDialog(r); }]);
      }
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
      /* ⚠ 改公告有三个入口，只有一个同步服务端（E-070-NOTICE）：
           roomSettings 走 g.Online.updateRoom()  ✓
           editNotice()  ← 这里，原来不同步
           /notice 命令   已在别处加了提示
         同一个字段三个入口两种行为，从不同地方改结果不一样 ——
         用户根本没法建立稳定的预期。接服务端前先如实告知。 */
      if (g.Online && g.Online.isOnline && g.Online.isOnline()) {
        g.UI.toast('公告只改了本机，其他设备暂不会同步', 'err', 5000);
      }
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
      var b = elc('button', 'chip' + (r.admins.indexOf(u.id) >= 0 ? ' on' : ''), u.nick);
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

  /* ---------- 检查更新 ----------
     清单在线维护，地址是多源的；下载源按实测速度排序。
     桌面版下载完打开所在文件夹让用户自己装 —— 不代他执行安装。 */
  function checkUpdateUI() {
    var d = elc('div', '');
    d.innerHTML = '<div class="form-tip">' + t('update.checking') + '</div>';
    var mo = g.UI.modal({ title: t('update.checking'), body: d, okText: null, cancelText: t('common.close') });

    g.Updater.check(null, true).then(function (r) {
      if (!r) { fail(t('common.unknownReason')); return; }

      if (!r.hasUpdate) {
        d.innerHTML = '<div class="form-tip">' + t('update.upToDate') +
          (r.latest ? '（' + g.UI.esc(r.latest) + '）' : '') + '</div>';
        mo.setTitle(t('update.upToDate'));
        return;
      }

      var a = r.asset;
      mo.setTitle(t('update.available'));
      d.innerHTML =
        '<div class="form-tip">' + t('update.latest') + '：<b>' + g.UI.esc(r.latest) + '</b>' +
        (r.current ? '　' + t('update.current') + '：' + g.UI.esc(r.current) : '') + '</div>' +
        '<div class="form-note">' + g.UI.esc(a.name) + ' · ' + g.Updater.fmtSize(a.size) + '</div>' +
        '<div id="srcBox" class="form-note">' + t('update.speed') + '</div>';

      var btn = elc('button', 'btn primary block', t('update.download'));
      btn.type = 'button';
      btn.disabled = true;   /* 测速完再放开，避免用户点了个慢源 */

      g.Updater.bestSource(a.mirrors).then(function (best) {
        var box = d.querySelector('#srcBox');
        if (best) {
          box.innerHTML = '<div class="field-label">' + t('update.source') + '</div>' +
            best.ranked.slice(0, 4).map(function (x, i) {
              return '<div class="src-item">' + (i === 0 ? '▶ ' : '　') +
                g.UI.esc(shortHost(x.url)) + ' — ' + x.ms + ' ms</div>';
            }).join('');
          btn.disabled = false;
        } else {
          box.textContent = t('update.fail') + '：' + t('common.networkError');
          btn.disabled = false;   /* 全测不到也给个能点的，至少能试 */
        }
      });

      btn.onclick = function () {
        var url = null;
        btn.disabled = true;
        btn.textContent = t('update.downloading');
        g.Updater.bestSource(a.mirrors).then(function (best) {
          url = best ? best.url : a.mirrors[0];
          if (g.ElectronBridge && g.ElectronBridge.downloadUpdate) {
            var pg = elc('div', 'dl-prog');
            pg.innerHTML = '<div class="dl-bar"><i style="width:0%"></i></div><span>' + t('update.downloading') + '</span>';
            d.appendChild(pg);
            var off = g.ElectronBridge.onDownloadProgress ? g.ElectronBridge.onDownloadProgress(function (p) {
              var bar = pg.querySelector('i'); if (bar) bar.style.width = (p.pct || 0) + '%';
              var sp = pg.querySelector('span');
              if (sp) sp.textContent = (p.pct || 0) + '%　' + g.Updater.fmtSize(p.loaded) + ' / ' + g.Updater.fmtSize(p.total);
            }) : null;
            /* ⚠ S-098：第三个参数是清单里的 sha256，必须传下去。
               不传 → 主进程降级成 no-hash → 界面上会显示"无法验证"，
               而不是"校验通过"。这两者必须让用户分得清。 */
            return g.ElectronBridge.downloadUpdate(url, a.name, a.sha256 || null).then(function (res) {
              if (off) off();
              if (res && res.tampered) {
                /* 内容对不上：这是最严重的一种失败，
                   必须说清"可能是被替换过"，不能只说"下载失败"。
                   用户据此会去 GitHub 手动下，而不是反复重试。 */
                btn.disabled = false; btn.textContent = t('retry');
                g.UI.toast(res.err || t('update.fail'), 'err', 12000);
                return;
              }
              if (res && res.ok) {
                mo.close();
                if (res.verifyNote) {
                  /* 校验通过和"没校验"必须分开说。
                     合成一句"已下载"的话，用户以为验证过了，
                     实际这份清单根本没提供哈希值。 */
                  g.UI.toast('已下载，请在弹出的文件夹里安装。注意：' + res.verifyNote, 'warn', 10000);
                } else {
                  g.UI.toast('已下载（已通过完整性校验），请在弹出的文件夹里安装');
                }
              } else {
                btn.disabled = false; btn.textContent = t('retry');
                g.UI.toast((res && res.err) || t('update.fail'), 'err');
              }
            });
          }
          /* 网页版：直接开文件直链，不跳网页 */
          window.open(url, '_blank'); mo.close();
        });
      };
      d.appendChild(btn);
    }).catch(function (e) { fail((e && e.message) || t('common.unknownReason')); });

    function fail(why) {
      d.innerHTML = '<div class="form-tip">' + t('update.fail') + '：' + g.UI.esc(why) + '</div>';
      mo.setTitle(t('update.fail'));
    }
  }

  /* 只显示域名，不把整个长地址糊在界面上 */
  function shortHost(u) {
    try { return new URL(u).host; } catch (e) { return u; }
  }

  /* ================= 用户卡 / 资料 ================= */
  function userCard(u, r) {
    var d = elc('div', '');
    var rr = g.ACL.roomRole(u, r);
    d.innerHTML =
      '<div class="uc-head"><div id="ucAv"></div><div>' +
      '<div class="uc-nick">' + g.UI.esc(u.nick) + '</div>' +
      /* ⚠ 申请说明是**写给站长看的私密信息**。
         注册面板自己写着"写给站长看，站长据此决定是否通过"，
         示例还是"我是高二3班的李明" —— 真实姓名、班级就写在里面。
         而这里对**任何成员点开任何人**都原样显示。

         申请人是按那个说明来写真实信息的，
         他默认只有站长能看到；结果全站成员都能看到。
         这属于"功能做对了，但放错了可见范围" ——
         比没有这个功能更糟，因为它诱导用户交出信息。

         只给有审核权限的人看。 */
      (g.ACL.can(me, 'audit.review')
        ? '<div class="uc-real">申请说明：' + g.UI.esc(u.note || '未填写') + '</div>'
        : '') +
      '<div class="uc-role">' + g.ACL.roleName(u) + ' · 本群：' + rr + '</div></div></div>' +
      '<div class="uc-bio">' + g.UI.esc(u.bio || '这个人很懒，什么都没写。') + '</div>' +
      '<div class="uc-meta">注册：' + g.UI.fmtFull(u.createdAt) + ' · 最后活跃：' + g.UI.fmtFull(u.lastSeen || u.createdAt) + '</div>' +
      '<div class="uc-state">' + (u.banned ? '<span class="tag red">已封禁</span> ' : '') +
      /* ⚠ 这里还在直接显示秒数（E-042 的漏网之鱼）。
         acl.js 里早就改成"还剩约 X 分钟/小时"了，
         但那是 canSpeak 的提示，用户卡是另一个渲染路径 ——
         同一个 bug 修了一半。
         禁言 60 分钟这里就显示"剩 3600 秒"，
         用户（和管理员）得自己换算成小时。 */
      (g.ACL.muted(u) ? '<span class="tag orange">禁言中（' + g.ACL.muteLeftText(u) + '）</span>' : '') + '</div>' +
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
      insertAtCursor('@' + u.nick + ' ');
    });

    /* 「禁止 TA 邀请别人」开关。
       群聊里成员互相拉人是常态，所以默认允许；
       但遇到不可信的人（乱拉人、拉进来的是广告号），
       管理员要能【单独关掉他的邀请权】——
       而不是只能把他踢出去或撤销管理员（那两招都太重）。
       房主与管理员本身不受这个开关影响。 */
    var isStaff = (r && (r.owner === me.id || (r.admins || []).indexOf(me.id) >= 0))
      || me.role === 'owner' || me.role === 'admin';
    if (r && isStaff && u.id !== me.id) {
      var cur = (r.noInvite || []).indexOf(u.id) < 0;   /* true = 现在能邀请 */
      var b2 = elc('button', 'btn ' + (cur ? 'ghost' : 'danger'),
        cur ? '禁止 TA 邀请别人' : '恢复 TA 的邀请权');
      b2.onclick = function () {
        var want = !cur;                                 /* true = 恢复 */
        r.noInvite = r.noInvite || [];
        var i = r.noInvite.indexOf(u.id);
        if (want) { if (i >= 0) r.noInvite.splice(i, 1); }
        else if (i < 0) r.noInvite.push(u.id);
        touch(r); save(true);
        g.UI.toast(want ? '已恢复「' + u.nick + '」的邀请权' : '已禁止「' + u.nick + '」邀请别人', 'ok');
        if (g.Online && g.Online.isOnline()) {
          g.Online.setCanInvite(r.id, u.id, want).catch(function (e) {
            /* 服务端失败要回滚本地，否则界面说禁止了、服务端还能生成 */
            if (want) r.noInvite.push(u.id);
            else r.noInvite = r.noInvite.filter(function (x) { return x !== u.id; });
            save(true);
            g.UI.toast('操作失败：' + ((e && e.message) || '网络错误'), 'err');
          });
        }
        mo.close();
      };
      acts.appendChild(b2);
    }
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
    /* ⚠ 群内禁言单独一个按钮（S-113）。
       原来这里只有全站禁言 —— 而这是**成员管理面板**，
       点开某人就是想管他在这个群里的行为，语义上要的就是群内禁言。
       两个按钮并存才能看出区别：
         「禁言」     = 全站，所有房间都不能说（需管理员及以上）
         「本群禁言」 = 只在这个群（房主/房管即可）
       合成一个的话，房主只能选全站，等于被迫越权。 */
    if (g.ACL.can(me, 'room.mute', r)) {
      var inMuted = !!(r.roomMuted && r.roomMuted[u.id] && r.roomMuted[u.id] > Date.now());
      btn(inMuted ? '解除本群禁言' : '本群禁言', '', function () {
        if (inMuted) {
          var prev = r.roomMuted[u.id];
          delete r.roomMuted[u.id]; touch(r); save();
          if (g.Online && g.Online.isOnline() && g.Online.setRoomMute) {
            g.Online.setRoomMute(r.id, u.id, 0).catch(function (e) {
              r.roomMuted[u.id] = prev;   /* 还原原值 */
              save(true);
              g.UI.toast('解除失败：' + ((e && e.message) || '网络错误'), 'err');
            });
          }
          return;
        }
        g.UI.prompt('本群禁言时长', '分钟', '10', function (v) {
          var m = parseInt(v, 10) || 10;
          r.roomMuted = r.roomMuted || {};
          r.roomMuted[u.id] = now() + m * 60000; touch(r);
          sysMsg(r.id, '「' + u.nick + '」在本群被禁言 ' + m + ' 分钟');
          log('mute', u.nick + ' ' + m + '分钟（本群）', r.id); save();
          if (g.Online && g.Online.isOnline() && g.Online.setRoomMute) {
            g.Online.setRoomMute(r.id, u.id, m).catch(function (e) {
              delete r.roomMuted[u.id]; save(true);
              g.UI.toast('禁言失败：' + ((e && e.message) || '网络错误'), 'err');
            });
          }
        });
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
        /* ⚠ 封禁必须走服务端（E-075，考古补回）。
           原来只改本地 u.banned 就 save() —— 在线模式下，
           下一次拉取会被服务端的 status 反向清掉，封禁等于没做。
           而用户看到的是「已封禁」，此人照样能登录发言。
           **封禁是安全动作，只写本地等于没封。**
           服务端拒了就把本地改回去，不留一个"看着封了其实没封"的状态。 */
        var next = !u.banned;
        var prev = u.banned;
        u.banned = next; touch(u);
        sysMsg(r.id, '「' + u.nick + '」' + (next ? '已被封禁' : '已被解封'));
        log(next ? 'ban' : 'unban', u.nick); save();
        if (g.Online && g.Online.isOnline() && g.Online.userReview) {
          g.Online.userReview(u.id, next ? 'banned' : 'active').catch(function (e) {
            u.banned = prev; touch(u); save(true); renderAll();
            g.UI.toast('封禁同步失败，已还原：' + ((e && e.message) || '网络错误'), 'err');
          });
        }
      });
    }
    if (g.ACL.can(me, 'user.grant', r)) {
      btn(u.role === 'admin' ? '撤销管理员' : '设为管理员', '', function () {
        /* ⚠ 必须同步服务端（E-078，考古补回）。
           roomSettings 里那个入口走 g.Online.setAdmin() 是同步的，
           而用户卡片里这个只改本地 —— **同一个操作两个入口，一个生效一个不生效**。
           用户从不同地方点，结果不一样，且都不报错。 */
        var want = u.role === 'admin' ? 'member' : 'admin';
        var prevRole = u.role;
        u.role = want;
        log(want === 'admin' ? 'grant-admin' : 'revoke-admin', u.nick);
        touch(u); sysMsg(r.id, '「' + u.nick + '」' + (want === 'admin' ? '已成为管理员' : '已被撤销管理员'));
        save();
        if (g.Online && g.Online.isOnline() && g.Online.setRole) {
          g.Online.setRole(u.id, want).catch(function (e) {
            u.role = prevRole; touch(u); save(true); renderAll();
            g.UI.toast('管理员设置同步失败，已还原：' + ((e && e.message) || '网络错误'), 'err');
          });
        }
      });
    }
    if (me.role === 'owner' && u.id !== me.id) {
      btn('转让站长', 'danger', function () {
        g.UI.confirm('把站长转让给「' + u.nick + '」？你将变为管理员。', function () {
          /* ⚠ 转让站长必须同步服务端（E-077，考古补回）。
             原来只改本地，换设备后站长又变回自己 ——
             **两个人同时以为自己是站长**，且各自的界面都显示自己是。
             服务端 user_role_set 里已经处理了"原站长降为管理员"这一步，
             所以只需调一次。 */
          var prevMe = me.role, prevU = u.role;
          me.role = 'admin'; touch(me); u.role = 'owner'; touch(u);
          sysMsg('public', '站长已转让给「' + u.nick + '」'); log('transfer', u.nick); save(); renderAll();
          if (g.Online && g.Online.isOnline() && g.Online.setRole) {
            g.Online.setRole(u.id, 'owner').catch(function (e) {
              me.role = prevMe; u.role = prevU; touch(me); touch(u); save(true); renderAll();
              g.UI.toast('转让同步失败，已还原：' + ((e && e.message) || '网络错误'), 'err');
            });
          }
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
    /* ⚠ 失败必须回滚成"操作前的值"，不能凭空算一个（本次考古发现）。
       原来写的是 minutes > 0 ? 0 : now() + 600000 ——
       **解除禁言（minutes=0）失败时，回滚成 now()+600000，即再禁 10 分钟。**
       若原本禁言到明天，一次失败的解除操作会把它改成 10 分钟后到期 ——
       **想解禁却失败，结果比成功还早解禁。** 这是禁言能被绕过的实际路径。

       正确做法：调之前先把原值存下来，失败就还原成原值。
       回滚绝不能"算"出一个新值，只能还原旧值。（S-111） */
    var prev = u.mutedUntil;
    g.Online.setMute(u.id, minutes).catch(function (e) {
      u.mutedUntil = prev;
      save(true); renderAll();
      g.UI.toast('禁言同步失败，已还原为原状态：' + ((e && e.message) || '网络错误'), 'err');
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

    /* ⚠ 套用前先快照（E-085-TPL）。
       一次改写全部 40 余项权限，套用后**不预览、不提示**，
       点"保存"才生效且直接覆盖 —— 用户只有两个选择：
       硬着头皮保存，或者关掉窗口重来一遍，而重来意味着
       之前手工调的每一条都得重新调。
       有了快照就能"恢复套用前"，把不可撤销变成可撤销。 */
    var snapshot = sels.map(function (sel) { return sel.value; });
    var undoBar = elc('div', 'perm-undo hidden');
    var undoBtn = elc('button', 'btn ghost sm', '恢复为套用前');
    undoBtn.onclick = function () {
      sels.forEach(function (sel, i) { sel.value = snapshot[i]; });
      undoBar.classList.add('hidden');
      g.UI.toast('已恢复为套用前的设置（尚未保存）', 'ok');
    };
    undoBar.appendChild(undoBtn);
    undoBar.appendChild(elc('span', 'perm-undo-tip', '　点“保存”后才会生效'));
    tpl.appendChild(undoBar);

    /* 快捷套用 */
    Array.prototype.forEach.call(tpl.querySelectorAll('[data-tpl]'), function (btn) {
      btn.onclick = function () {
        var mode = btn.getAttribute('data-tpl');
        /* ⚠ 套用会一次改写全部权限，必须先确认（E-085）。
           不确认的话：用户想点"普通成员模板"，手指一偏点到"全部恢复继承"，
           40 多项设置瞬间归零，而界面上看不出发生过什么。 */
        var label = ({ admin: '管理员模板', member: '普通成员模板', clear: '全部恢复继承' })[mode] || mode;
        if (!window.confirm('套用「' + label + '」会改写下面全部权限项，确定吗？\n\n可以先套用，再用“恢复为套用前”撤销。')) return;
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
        undoBar.classList.remove('hidden');
        g.UI.toast('已套用「' + label + '」，尚未保存', 'ok');
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

  /* ================= 消息通知设置 ================= */

  /* 免打扰状态条。
     免打扰生效时必须在界面上说出来 —— 否则用户只会以为通知功能坏了，
     不会意识到是自己（或时段）把它关掉的。 */
  function renderDndTip() {
    var el = document.getElementById('dndTip');
    if (!el) return;
    var N = g.Notifier, txt = '';
    if (N) {
      var q = N.quiet();
      if (q === 'off') txt = '通知已关闭，不会收到任何提醒';
      else if (q === 'dnd') txt = '免打扰中：消息照常收到，只是不弹提醒';
      else if (q === 'hours') txt = '夜间免打扰中（' + N.get('qFrom') + ':00 – ' + N.get('qTo') + ':00）';
    }
    if (txt) { el.textContent = txt; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  }

  /* 授权引导条。
     不授权的话，页面切到后台就只剩标题栏计数在动 —— 太弱了。
     这里给一个温和的一次性引导，用户可以关掉，关了不再烦他。 */
  var CTA_KEY = 'wxlg_notify_cta_dismiss';
  function renderNotifyCta() {
    var el = document.getElementById('notifyCta');
    var N = g.Notifier;
    if (!el || !N) return;
    try { if (localStorage.getItem(CTA_KEY) === '1') { el.classList.add('hidden'); return; } } catch (e) { }
    if (!N.supported() || N.permission() !== 'default') { el.classList.add('hidden'); return; }

    el.innerHTML = '';
    var ic = elc('span', '');
    ic.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-bell-off"/></svg>';
    el.appendChild(ic);
    el.appendChild(elc('span', '', '开启通知后，切到别的页面也能收到消息提醒'));
    var b = elc('button', 'btn ghost sm', '开启');
    b.type = 'button';
    b.onclick = function () {
      N.request(function (st) {
        g.UI.toast(st === 'granted' ? '已开启通知' : '未获授权', st === 'granted' ? 'ok' : 'err');
        renderNotifyCta();
      });
    };
    el.appendChild(b);
    var x = elc('button', 'notify-cta-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', '不再提示');
    x.onclick = function () {
      try { localStorage.setItem(CTA_KEY, '1'); } catch (e) { }
      el.classList.add('hidden');
    };
    el.appendChild(x);
    el.classList.remove('hidden');
  }

  function notifySettings() {
    var N = g.Notifier;
    if (!N) { g.UI.toast('通知模块未加载', 'err'); return; }
    var d = elc('div', '');

    /* ---- 总开关 ---- */
    d.appendChild(elc('div', 'pref-sec-title', '通知'));
    var rowOn = elc('label', 'pref-row');
    rowOn.innerHTML = '<span>启用消息通知</span>';
    var cbOn = document.createElement('input');
    cbOn.type = 'checkbox'; cbOn.checked = !!N.get('enabled');
    cbOn.onchange = function () { N.set('enabled', cbOn.checked); renderDndTip(); };
    rowOn.appendChild(cbOn); d.appendChild(rowOn);

    /* ---- 授权状态 ---- */
    var p = N.permission();
    var permRow = elc('div', 'pref-row');
    var permTxt = ({
      granted: '已授权，可以弹出通知',
      denied: '已被浏览器拒绝，需到站点设置里手动放行',
      default: '尚未授权，点右边按钮申请',
      unsupported: '当前环境不支持系统通知（仍会有提示音）'
    })[p] || ('状态：' + p);
    permRow.innerHTML = '<span>系统通知授权<br><i class="pref-note">' + permTxt + '</i></span>';
    if (p !== 'granted' && p !== 'unsupported') {
      var bReq = elc('button', 'btn ghost sm', '申请授权');
      bReq.type = 'button';
      bReq.onclick = function () {
        N.request(function (st) {
          g.UI.toast(st === 'granted' ? '已授权' : '未获授权（' + st + '）', st === 'granted' ? 'ok' : 'err');
          notifySettings();
        });
      };
      permRow.appendChild(bReq);
    }
    d.appendChild(permRow);

    /* ---- 内容预览 ---- */
    var rowPv = elc('label', 'pref-row');
    rowPv.innerHTML = '<span>通知里显示消息内容<br><i class="pref-note">关掉后只显示「新消息」，锁屏时不泄内容</i></span>';
    var cbPv = document.createElement('input');
    cbPv.type = 'checkbox'; cbPv.checked = !!N.get('preview');
    cbPv.onchange = function () { N.set('preview', cbPv.checked); };
    rowPv.appendChild(cbPv); d.appendChild(rowPv);

    /* ---- 提示音 ---- */
    var rowSnd = elc('label', 'pref-row');
    rowSnd.innerHTML = '<span>提示音</span>';
    var cbSnd = document.createElement('input');
    cbSnd.type = 'checkbox'; cbSnd.checked = !!N.get('sound');
    cbSnd.onchange = function () { N.set('sound', cbSnd.checked); };
    rowSnd.appendChild(cbSnd); d.appendChild(rowSnd);

    /* ---- 免打扰 ---- */
    d.appendChild(elc('div', 'pref-sec-title', '免打扰'));
    var rowDnd = elc('label', 'pref-row');
    rowDnd.innerHTML = '<span>全局免打扰<br><i class="pref-note">消息照常收到，只是不弹窗、不响铃</i></span>';
    var cbDnd = document.createElement('input');
    cbDnd.type = 'checkbox'; cbDnd.checked = !!N.get('dnd');
    cbDnd.onchange = function () { N.set('dnd', cbDnd.checked); renderDndTip(); };
    rowDnd.appendChild(cbDnd); d.appendChild(rowDnd);

    var rowQ = elc('label', 'pref-row');
    rowQ.innerHTML = '<span>按时段免打扰</span>';
    var cbQ = document.createElement('input');
    cbQ.type = 'checkbox'; cbQ.checked = !!N.get('quiet');
    cbQ.onchange = function () { N.set('quiet', cbQ.checked); renderDndTip(); };
    rowQ.appendChild(cbQ); d.appendChild(rowQ);

    var rowTime = elc('div', 'pref-row');
    rowTime.innerHTML = '<span>时段</span>';
    var selA = document.createElement('select'); selA.className = 'field sm';
    var selB = document.createElement('select'); selB.className = 'field sm';
    for (var h = 0; h < 24; h++) {
      var o1 = document.createElement('option'); o1.value = h; o1.textContent = h + ':00'; selA.appendChild(o1);
      var o2 = document.createElement('option'); o2.value = h; o2.textContent = h + ':00'; selB.appendChild(o2);
    }
    selA.value = N.get('qFrom'); selB.value = N.get('qTo');
    selA.onchange = function () { N.set('qFrom', selA.value * 1); renderDndTip(); };
    selB.onchange = function () { N.set('qTo', selB.value * 1); renderDndTip(); };
    rowTime.appendChild(selA);
    rowTime.appendChild(elc('span', 'pref-note', ' 至 '));
    rowTime.appendChild(selB);
    d.appendChild(rowTime);

    /* ---- 按会话静音 ---- */
    var muted = Object.keys(N.cfg().rooms || {});
    if (muted.length) {
      d.appendChild(elc('div', 'pref-sec-title', '已单独静音的会话'));
      muted.forEach(function (rid) {
        var r = findRoom(rid);
        var row = elc('div', 'pref-row');
        row.innerHTML = '<span>' + g.UI.esc(r ? roomTitleOf(r) : rid) + '</span>';
        var b = elc('button', 'btn ghost sm', '取消静音');
        b.type = 'button';
        b.onclick = function () { N.setRoomMuted(rid, false); notifySettings(); renderSidebar(); };
        row.appendChild(b);
        d.appendChild(row);
      });
    }

    /* ---- 网页版的边界，必须说清楚 ----
       用户的核心诉求是"不盯着页面时也能被提醒"。
       网页关掉之后浏览器根本不在运行，无从提醒 —— 这是网页的硬限制，
       不是没做出来。与其让人反复试，不如直说，并给出真正管用的路径。 */
    d.appendChild(elc('div', 'pref-sec-title', '想彻底关掉网页也能收到'));
    var note = elc('div', 'pref-row');
    note.innerHTML =
      '<span><i class="pref-note">网页关掉后浏览器就不运行了，此时无法提醒 —— ' +
      '这是网页的硬限制。要做到这一点，需要把它装成应用：</i></span>';
    d.appendChild(note);

    var rowInstall = elc('div', 'pref-row');
    var instBtns = elc('div', '');
    instBtns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
    var bWin = elc('a', 'btn ghost sm', '装到电脑');
    bWin.href = 'https://github.com/liuyiming2024/Chat/releases/latest';
    bWin.target = '_blank'; bWin.rel = 'noopener';
    var bAnd = elc('a', 'btn ghost sm', '装到手机');
    bAnd.href = 'https://github.com/liuyiming2024/Chat/releases/latest';
    bAnd.target = '_blank'; bAnd.rel = 'noopener';
    instBtns.appendChild(bWin); instBtns.appendChild(bAnd);
    rowInstall.appendChild(instBtns);
    d.appendChild(rowInstall);

    /* 手机/桌面浏览器支持 PWA 时，给个更近的一键入口 */
    var bPwa = elc('div', 'pref-row');
    var pwaSpan = elc('span', '', '或者用浏览器自带「安装」（免下载）');
    bPwa.appendChild(pwaSpan);
    var bPwaBtn = elc('button', 'btn ghost sm', '添加到桌面');
    bPwaBtn.type = 'button';
    bPwaBtn.onclick = function () {
      if (g.__installPrompt) { g.__installPrompt.prompt(); }
      else { g.UI.toast('当前浏览器不支持直接安装，请用上面的下载链接', 'err'); }
    };
    bPwa.appendChild(bPwaBtn);
    d.appendChild(bPwa);

    /* ---- 测试 ---- */
    var rowT = elc('div', 'pref-row');
    rowT.innerHTML = '<span>试一下效果</span>';
    var bT = elc('button', 'btn ghost sm', '发一条测试通知');
    bT.type = 'button';
    bT.onclick = function () {
      if (N.permission() !== 'granted') {
        N.request(function () { N.incoming({ roomId: '__test', roomName: '测试', fromName: '聊天室', text: '这是一条测试通知', mine: false }); });
      } else {
        N.incoming({ roomId: '__test', roomName: '测试', fromName: '聊天室', text: '这是一条测试通知', mine: false });
      }
    };
    rowT.appendChild(bT); d.appendChild(rowT);

    g.UI.modal({ title: '消息通知与免打扰', body: d, okText: '完成', onOk: function () { renderDndTip(); } });
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
      '<label class="field-label">修改登录密码（留空不改）</label>' +
      /* 在线模式下必须有"当前密码"输入框（S-011）。
         服务端 user_password 要校验旧密码，没这个框就调不了；
         而只改本地 pwdHash 的话，换台设备用新密码登不上 ——
         用户以为改成功了，其实只改了这台机器。 */
      '<input class="field" id="pOldPwd" type="password" placeholder="当前密码（在线模式必填）">' +
      '<input class="field" id="pPwd" type="password" placeholder="新密码（至少 4 位）">' +
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

    /* 通知设置入口：放在资料面板里，而不是往头部按钮区再塞一个图标 ——
       那排按钮已经够挤了，再加一个只会提高误触代价。 */
    var nBar = elc('div', 'pref-row');
    nBar.innerHTML = '<span>消息通知与免打扰</span>';
    var nBtn = elc('button', 'btn ghost sm', '去设置');
    nBtn.type = 'button';
    nBtn.onclick = function () { notifySettings(); };
    nBar.appendChild(nBtn);
    d.appendChild(nBar);

    /* 语言切换 */
    var lBar = elc('div', 'pref-row');
    lBar.innerHTML = '<span>' + t('lang.title') + '</span>';
    var lSel = elc('select', 'sel');
    lSel.id = 'pLang';
    /* ⚠ 三处 bug（S-062），任一个都让多语言彻底不可用：
         ① g.I18n.cur() 根本不存在（导出的是 get）——
            调用即抛 TypeError，而这段在渲染设置面板的循环里，
            **整个面板渲染到这行就中断了**，后面的设置项全部消失。
            这解释了为什么"语言切换"一直是坏的：不是没接，是接错了。
         ② 值用 'zh'，但 SUPPORTED 里是 'zh-CN' ——
            set() 会判定不支持并回退到默认值。
         ③ 切换后不重绘 —— 界面文案不变，用户以为点了没用。 */
    [['zh-CN', t('lang.zh')], ['en', t('lang.en')]].forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0]; op.textContent = o[1];
      if (g.I18n.get() === o[0]) op.selected = true;
      lSel.appendChild(op);
    });
    lSel.onchange = function () {
      var v = lSel.value;
      if (g.I18n.get() === v) return;
      g.I18n.load(v);
      try { if (g.I18n.apply) g.I18n.apply(); } catch (e) { }
      g.UI.toast(v === 'zh-CN' ? '已切换为简体中文，正在重新载入…' : 'Switched to English, reloading…');
      /* 动态渲染的文案（toast、菜单、按钮）不重载就不会变 ——
         只 apply() 的话用户会看到"一半变了、一半没变"，
         比不变更令人困惑。 */
      setTimeout(function () { try { location.reload(); } catch (e) { } }, 600);
    };
    lBar.appendChild(lSel);
    d.appendChild(lBar);

    /* 发送键设置（E-047）。
       ⚠ 原来这个入口只在管理面板的「站点」tab 里 ——
       普通用户根本够不着。而输入框是 textarea，
       绝大多数多行输入框 Enter 是换行，用户打第一行回车就直接发出去了。
       **一个影响所有人的默认行为，改它的开关却只有管理员能碰。**
       所以放一份到「我的资料」，谁都能改自己的。

       本条曾被 ghpull 覆盖丢失（上一轮改动未推送即拉取），故重新应用，
       并已加断言 [3.17] 防再次丢失。 */
    var eBar = elc('div', 'pref-row');
    eBar.innerHTML = '<span>Enter 键</span>';
    var eSel = elc('select', 'field sm');
    [['send', 'Enter 发送 / Shift+Enter 换行'],
     ['newline', 'Enter 换行 / Ctrl+Enter 发送']].forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0]; op.textContent = o[1];
      if (enterSends() === o[0]) op.selected = true;
      eSel.appendChild(op);
    });
    eSel.onchange = function () {
      /* 必须用 ENTER_KEY 常量，不能另写一个字符串。
         写成两个不同的 key 的话，这里改了那边读不到 ——
         表现为「改了没生效」，而两处代码看着都对。 */
      try { localStorage.setItem(ENTER_KEY, eSel.value); } catch (e) { }
      g.UI.toast(eSel.value === 'send' ? '已改为 Enter 发送' : '已改为 Enter 换行');
    };
    eBar.appendChild(eSel);
    d.appendChild(eBar);

    /* 检查更新。桌面版/安卓版才有意义 —— 网页版本身就是最新的，
       但入口保留，用户也能从这里拿到客户端下载地址。 */
    var uBar = elc('div', 'pref-row');
    var ver = g.Updater && g.Updater.currentVersion();
    uBar.innerHTML = '<span>' + t('update.current') + '：' + (ver || '—') + '</span>';
    var uBtn = elc('button', 'btn ghost sm', t('update.checking'));
    uBtn.type = 'button';
    uBtn.textContent = '检查更新';
    uBtn.onclick = function () { checkUpdateUI(); };
    uBar.appendChild(uBtn);
    d.appendChild(uBar);

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

          /* 在线：必须走服务端改。
             只改本地的话，换设备用新密码登不上，
             而用户看到的提示是"保存成功" —— 这是最糟的一种结果。 */
          if (g.Online && g.Online.isOnline && g.Online.isOnline()) {
            var op = (body.querySelector('#pOldPwd') || {}).value || '';
            if (!op) { g.UI.toast('在线模式下修改密码需要先填当前密码'); return false; }
            if (op === p) { g.UI.toast('新密码不能与当前密码相同'); return false; }
            g.Online.changePwd(op, p).then(function () {
              g.UI.toast('密码已更新', 'ok');
            }).catch(function (e) {
              /* 服务端会明确报"原密码错误"/"至少 4 位"，
                 这两条原来无处显示（S-011），必须显示出来。 */
              g.UI.toast('修改失败：' + (e && e.message ? e.message : '网络错误'), 'err');
            });
          } else {
            var s = g.SHA256.randomId(12);
            me.pwdSalt = s; me.pwdHash = hashPwd(p, s);
          }
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
        var nv2 = nickValid(n);
        if (!nv2.ok) { g.UI.toast(nv2.why, 'err'); return false; }
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
        /* ⚠ 手动开户只写本地（E-063-OPEN）。
           在线模式下站长开的账号只在自己这台设备存在，
           对方换设备登录就是「用户不存在」—— 而站长这里明明白白提示"已开户"。
           这是最坑的一类：他以为帮人开好了，对方根本登不进来，
           两边都不知道问题出在哪。接服务端前先如实告知。 */
        if (g.Online && g.Online.isOnline && g.Online.isOnline()) {
          g.UI.toast('已开户：' + n + '（仅本机会话，在线模式下对方暂不能登录）', 'err', 6000);
        } else {
          g.UI.toast('已开户：' + n, 'ok');
        }
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
            else g.UI.prompt('禁言分钟数', '', '10', function (v) {
              /* 用户卡片里的禁言是**全站**禁言（与群内 /mute 区分开），
                 所以这里必须走 syncMute 同步服务端 ——
                 原来缺这一步，跟 /mute 一样只改本地（E-068 同族）。 */
              var m = parseInt(v, 10) || 10;
              u.mutedUntil = now() + m * 60000; touch(u); syncMute(u, m);
              log('mute', u.nick + '（全站）'); save();
            });
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
                    g.Online.userDelete(u.id).catch(function (e) {
                      g.UI.toast('服务端删除失败（本地已删除）：'
                        + (e && e.message ? e.message : ''), 'err');
                    });
                  }
                } else {
                  if (g.Online && g.Online.isOnline()) {
                    g.Online.userReview(u.id, 'banned').catch(function (e) {
                      g.UI.toast('服务端封禁失败（本地已改）：'
                        + (e && e.message ? e.message : ''), 'err');
                    });
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
              g.Online.userReview(u.id, 'active')
                .then(function () {
                  if (g.Online.addMember) {
                    g.Online.addMember('public', u.id).catch(function (e2) {
                      /* 别静默吞（S-054 同族）：
                         审核通过了但没进公屏，用户会在成员列表里找不到人，
                         而界面上什么都没说。 */
                      g.UI.toast('已通过，但加入公屏失败：'
                        + (e2 && e2.message ? e2.message : '网络错误'), 'err');
                    });
                  }
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
                    g.Online.userDelete(u.id).catch(function (e) {
                      g.UI.toast('服务端删除失败（本地已删除）：'
                        + (e && e.message ? e.message : ''), 'err');
                    });
                  }
                } else {
                  if (g.Online && g.Online.isOnline()) {
                    g.Online.userReview(u.id, 'banned').catch(function (e) {
                      g.UI.toast('服务端封禁失败（本地已改）：'
                        + (e && e.message ? e.message : ''), 'err');
                    });
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
            '<td><svg class="ic" aria-hidden="true"><use href="#i-check"/></svg></td>' +
            '<td>' + (g.ACL.ROLE_PERMS.admin.indexOf(p) >= 0 ? '<svg class="ic" aria-hidden="true"><use href="#i-check"/></svg>' : '—') + '</td>' +
            '<td>' + (g.ACL.ROLE_PERMS.member.indexOf(p) >= 0 ? '<svg class="ic" aria-hidden="true"><use href="#i-check"/></svg>' : '—') + '</td></tr>';
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
          /* 语言选择。
             i18n.js 里有完整的中英词典，但**从来没有被调用过**（S-062） ——
             词典写了等于没写。所以先在这里给一个入口，
             让用户能真正切换；具体文案的接入分批做。 */
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
          /* ⚠ 这句话原来【硬编码】写"不上传任何服务器"（E-051）。
             在线模式下账号与消息都在服务端 —— 声明与实际相反，
             用户看到它会以为内容没离开本机，从而放进去不该放的东西。
             这类"界面在骗人"比功能坏了更糟：用户按它做判断。
             所以按当前模式分别写。 */
          ((g.Online && g.Online.isOnline && g.Online.isOnline())
            ? '<div class="field-hint">当前为<b>在线模式</b>：账号与消息存在服务端数据库，' +
              '换设备可见；媒体文件存在云端存储。本机只保留一份缓存。'
            : '<div class="field-hint">当前为<b>本机模式</b>（未连后端）：' +
              '数据保存在本机浏览器（localStorage + IndexedDB），不上传任何服务器。') +
          /* 原来写「用导出/导入 JSON 搬运」（E-044），
             而 JSON 里只有 mediaId —— 搬到新设备后所有图片视频都打不开。
             用户是按文档操作的，所以他会以为是自己操作错了。
             所以这里必须说清：普通 JSON 只搬结构与文字，
             要连媒体一起搬得用「完整备份」。 */
          '要换设备或备份，用下面的「完整备份」（含图片 / 视频 / 语音）；' +
          '「导出 JSON」只含文字与结构，不含媒体。</div>' +
          '<div class="sec-title">数据</div>' +
          '<button class="btn ghost" id="stExportFull">完整备份（含媒体）</button> ' +
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
        /* 完整备份：连媒体一起打包，用于换设备 / 清理前备份。
           普通「导出 JSON」只含结构与文字 —— 那个搬不了图片视频。 */
        sd.querySelector('#stExportFull').onclick = function () {
          var btn = this;
          btn.disabled = true;
          var label = btn.textContent;
          buildFullBackup(function (done, total) {
            btn.textContent = '打包中 ' + done + '/' + total;
          }).then(function (pack) {
            var n = Object.keys(pack.media || {}).length;
            var blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) { } }, 60000);
            a.download = 'chat-full-' + new Date().toISOString().slice(0, 10) + '.json';
            a.click();
            markBackup();
            g.UI.toast('已导出完整备份（含 ' + n + ' 个媒体，'
              + (blob.size / 1048576).toFixed(1) + ' MB）', 'ok');
            btn.disabled = false; btn.textContent = label;
          }).catch(function (e) {
            g.UI.toast('导出失败：' + (e && e.message ? e.message : '未知错误'), 'err');
            btn.disabled = false; btn.textContent = label;
          });
        };
        sd.querySelector('#stExport').onclick = function () {
          /* ⚠ 两个问题叠加（E-043 的最后一处残留）：

             ① 导出后无条件提示"已导出备份"，但**没做任何成功判定**。
                JSON.stringify 在状态里有循环引用、或含 undefined/BigInt 时会抛，
                Blob/下载在某些浏览器会被策略拦掉 ——
                这些情况下用户看到的是"已导出备份"，而文件根本没下来。

             ② 更关键的：这份 JSON **不含媒体本体**（只有 mediaId，
                图片视频在 IndexedDB 里）。按钮叫"导出 JSON"，
                旁边另有一个"完整备份（含媒体）"。
                只提示"已导出备份"会让人以为这就是完整备份 ——
                于是照着"先备份再清理"操作，清理完媒体永久没了。

             所以：① 真判成败；② 提示里必须说清"不含图片视频"。 */
          var raw;
          try { raw = JSON.stringify(S, null, 2); }
          catch (err) {
            g.UI.toast('导出失败：状态数据无法序列化（' + (err && err.message ? err.message : '未知原因') + '）', 'err', 6000);
            return;
          }
          var blob;
          try { blob = new Blob([raw], { type: 'application/json' }); }
          catch (err2) {
            g.UI.toast('导出失败：无法生成文件', 'err', 6000);
            return;
          }
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) { } }, 60000);
          a.download = 'chat-state-' + new Date().toISOString().slice(0, 10) + '.json';
          try {
            a.click();
          } catch (err3) {
            g.UI.toast('导出失败：浏览器阻止了下载', 'err', 6000);
            return;
          }
          markBackup();
          g.UI.toast('已导出（不含图片视频；要连媒体一起备份请用「完整备份」）', 'ok', 6000);
        };
        sd.querySelector('#stFile').onchange = function (e) {
          var f = e.target.files[0]; if (!f) return;
          /* ⚠ 导入没有二次确认（E-099-IMPORT）。
             选错文件就直接 mergeState 或 restoreFullBackup，
             后者还会 location.reload() —— 用户来不及看清发生了什么，
             页面已经变成新数据。对照：同面板的「重置站点」有 confirm，
             **更危险的导入反而没有**，这是明显的不一致。

             确认文案必须说出「会覆盖现有数据」，只说"确定导入吗"没有意义 ——
             用户以为导入是"追加"。 */
          if (!window.confirm('即将用「' + f.name + '」覆盖现有的全部聊天数据。\n\n'
            + '当前设备上的记录会被替换，且此操作无法撤销。\n\n'
            + '确定要继续吗？（建议先导出一份现有备份）')) {
            e.target.value = '';
            return;
          }
          var fr = new FileReader();
          fr.onload = function () {
            try {
              var o = JSON.parse(fr.result);
              /* 完整备份包（含媒体）走另一条路：
                 先还原媒体再覆盖状态，顺序不能反。 */
              if (o && o.kind === 'chat-full-backup') {
                restoreFullBackup(o).then(function () {
                  g.UI.toast('已导入完整备份（含 '
                    + Object.keys(o.media || {}).length + ' 个媒体）', 'ok');
                  mo.close();
                  try { location.reload(); } catch (e) { }
                }).catch(function (err2) {
                  /* ⚠ 原来没有 catch —— 还原媒体的过程失败（IndexedDB 配额满、
                     某个文件损坏）时 Promise 直接 reject，**没有任何提示**。
                     用户看着"正在导入"的界面一直停在那儿，
                     既不知道成功也不知道失败，只能刷新，
                     而刷新后是半套数据（状态进去了、媒体没进去）——
                     这比导入失败更难收拾，因为他以为已经导完了。 */
                  g.UI.toast('导入失败：' + (err2 && err2.message ? err2.message : '未知原因')
                    + '。数据可能只还原了一部分，请勿清理旧数据。', 'err', 10000);
                });
                return;
              }
              /* ⚠ 两个问题：
                 ① mergeState 返回 true 只说明"这份数据里有 users 字段"，
                    不代表全部内容都进来了 —— 但只要它返回真就提示"已导入并合并"。
                 ② save() 写不进去（配额满）时照样提示成功：
                    内存里合并好了，刷新就全没了，而用户以为存住了。
                    save() 现在返回是否写成，必须看它的结果。 */
              if (mergeState(o)) {
                var wrote = save(true);
                if (wrote === false) {
                  g.UI.toast('已合并但没能存下来（存储已满），刷新后会丢失。请先清理空间再重试。', 'err', 10000);
                } else {
                  g.UI.toast('已导入并合并（与现有数据合并，不是替换）', 'ok');
                  mo.close();
                }
              }
              else g.UI.toast('文件格式不正确', 'err');
            } catch (er) { g.UI.toast('解析失败', 'err'); }
          };
          fr.readAsText(f);
        };
        sd.querySelector('#stImport').onclick = function () { sd.querySelector('#stFile').click(); };
        /* 这个面板会显示部署形态、用户数、房间数、消息总数、快照体积。
           权限表里既然有 sys.env，就该真的按它来 —— 收回后仍能看到等于没收回。 */
        sd.querySelector('#stEnv').onclick = function () {
          if (!g.ACL.can(me, 'sys.env')) { g.UI.toast('没有查看运行环境的权限', 'err'); return; }
          envModal();
        };
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
            /* ⚠ 初始密码不能写死成 'admin'（E-098，考古补回）。
               原来密码固定为 admin，还用 toast 当众明文显示出来 ——
               **写死在代码里的密码等于没有密码**，任何人看了源码就能以站长身份登录。
               而明文提示又让旁观者（截图、录屏、旁人一眼）直接拿到。

               改成随机生成，并且**强制立即修改**：不设新密码就一直弹，
               不给"待会儿再改"的机会 —— 那个"待会儿"通常是永远。 */
            var s = g.SHA256.randomId(12);
            var initPwd = g.SHA256.randomId(10);
            me = {
              id: uid('u'), nick: '站长', note: '站长', status: 'active', pwdHash: hashPwd(initPwd, s), pwdSalt: s,
              role: 'owner', perms: [], banned: false, mutedUntil: 0, bio: '', createdAt: now(), updatedAt: now(), lastSeen: now()
            };
            S.users.push(me);
            setMeId(me.id);
            save(); mo.close();
            renderAll();
            /* 在线模式下重置并未清服务端（见下），提示要说清范围，别让站长以为清干净了 */
            var onlineLeft = (g.Online && g.Online.isOnline())
              ? '注意：在线模式下的服务端数据并未清除，重新联网后会同步回来。' : '';
            forceSetPassword(initPwd, onlineLeft);
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
          /* 语言。切换后要重绘整个界面才看得见 ——
             I18n.set() 内部会调用 apply()，但那只覆盖带 data-i18n 的静态元素；
             动态渲染的文案要重新 render 才更新。
             **不说清这点，用户切完发现只有一部分变了，会以为功能坏了。** */
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
    /* 深色模式快捷切换（E-062）。原按钮不存在，这行绑定也就从未生效过。 */
    (function () {
      var bt = $('btnTheme');
      if (!bt) return;
      var cur = 'auto';
      try { cur = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { }
      var setT = function (t) {
        cur = t; applyTheme(t);
        try { localStorage.setItem(THEME_KEY, t); } catch (e) { }
        bt.title = t === 'dark' ? '当前：深色（点此切跟随系统）'
          : (t === 'light' ? '当前：浅色（点此切深色）' : '当前：跟随系统（点此切深色）');
      };
      setT(cur);
      bt.onclick = function () { setT(cur === 'dark' ? 'auto' : 'dark'); };
    })();
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
    /* ⚠ 这里原来绑了一次 change（E-093，考古补回）：
       取 files[0] 发一张，然后把 value 清空。
       而下面「多图连发」那段又 addEventListener 绑了一次。
       **onchange= 先注册、先执行**：它发完第一张就把 value 置空，
       等第二个处理器跑起来时 files 已经是空的 → 直接 return。
       于是选 3 张图永远只发出第 1 张，且不提示、不报错。

       更隐蔽的是：单张能发成功，所以用户只会以为"多图不支持"，
       不会想到是 bug。修法：删掉这个抢占的单图处理器，
       统一交给下面支持多张的那一个（它内部已处理单张的情况）。 */
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
        /* 门禁一并作废：退出后再进来要重新输保护密码。
           账号可以记住，保护密码不记 —— 这是两套东西，别混在一起。 */
        /* ⚠ 必须通知服务端作废会话（E-079，考古补回）。
           原来只清本地，服务端那条 token 继续有效 14 天 ——
           用户以为退出了，其实没有。 */
        try { if (g.SB && g.SB.logout) g.SB.logout(); } catch (e) { }
        clrMe();
        clrGate();
        try { if (g.ElectronBridge) g.ElectronBridge.bridgeClear(); } catch (e) { }
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
      /* ⚠ 注释写着"输入即记录"，其实只记进了内存里的 drafts 对象，
         没有触发落盘 —— drafts 是靠 save() 顺带写进去的。
         结果：打了一半关掉页面，草稿就没了。
         用户感知是"我明明写了，怎么没了"，而且不会怀疑是自己没保存，
         因为草稿本来就该自动留着。

         加 800ms 防抖落盘：打字过程中不会每一下都写（那样也卡），
         停手不到一秒就存住。 */
      var draftTimer = null;
      ta.addEventListener('input', function () {
        drafts[cur] = ta.value;
        autoGrow(ta);
        typingAt = now();
        /* 接近上限时给出提示，别等提交才说（S-101）。
           只在超过 90% 时才显示，平时不占地方。 */
        updateLenHint(ta);
        if (draftTimer) clearTimeout(draftTimer);
        draftTimer = setTimeout(function () { save(true); }, 800);
      });
    }
    /* ⚠ 三个关闭钩子必须全部挂在全局（S-115 / S-120）。

       **我上一轮犯的错**：只把 beforeunload 挂到了全局，
       而 pagehide / visibilitychange 还留在上面的 `if (ta)` 里面 ——
       输入框不存在时它们压根不注册。

       这条正中 iOS：**iOS Safari 基本不触发 beforeunload**，
       pagehide 是那里唯一可靠的钩子。而它恰好是被条件包住的那个。
       手机上切个 App 回来，从上次 debounce 到切走之间的内容全没了。

       三个钩子各有各的覆盖场景，缺一个就有一条路漏：
         beforeunload      —— 桌面关标签页/关窗口
         pagehide          —— iOS 唯一可靠的那个（切 App、前进后退缓存）
         visibilitychange  —— 切后台最常见，且是唯一能"提前"跑的

       注意：断电 / 强杀 / 进程崩溃**任何钩子都拦不住**（页面来不及跑代码），
       那些场景的丢失窗口取决于落盘频率（心跳 15 秒 + 输入防抖 800ms），
       不是靠加钩子能解决的 —— 这点要说清楚，不能假装钩子能兜住。 */
    window.addEventListener('pagehide', function () { syncFlushOnLeave(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) syncFlushOnLeave();
    });
    window.addEventListener('beforeunload', function () { syncFlushOnLeave(); });
    /* 语音：点一下开始，再点一下发送；或按住说话 */
    var bv = $('btnVoice');
    if (bv) {
      bv.onclick = function () {
        if (rec) { stopRecord(false); } else { startRecord(); }
      };
    }
    /* 取消录音的唯一出口。
       没有它，误触录音之后只能：把不想发的语音发出去，或刷新页面。
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
        /* 固定发起时的房间：连发到第几张时切了房间，剩下的不能跟着跑过去 */
        var rid0 = cur;
        fs.forEach(function (f, i) {
          setTimeout(function () { sendMediaFile(f, 'image', rid0); }, i * 350);
        });
      });
    });
    /* ⚠ 粘贴图片：截图后 Ctrl+V 是最自然的发图方式，原来完全没接。
       用户粘了一张图，光标后面什么都没出现，他只会以为"粘贴坏了"，
       不会想到是这个功能不存在 —— 因为别的聊天软件都有。
       只处理图片：粘文字仍走浏览器默认行为，不能被抢走。 */
    ta.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var imgs = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.kind === 'file' && /^image\//.test(it.type || '')) {
          var f = it.getAsFile();
          if (f) imgs.push(f);
        }
      }
      if (!imgs.length) return;
      e.preventDefault();   /* 有图才拦，粘文字照常 */
      var rid0 = cur;   /* 同上：粘贴多图也是连发，房间必须固定 */
      imgs.forEach(function (f, i2) {
        setTimeout(function () { sendMediaFile(f, 'image', rid0); }, i2 * 350);
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
    /* ⚠ 原来每敲一个字就 renderSidebar() 重建整个房间列表（S-076 只修了搜索弹窗，
       侧栏这个框漏了）。房间多的时候打字明显卡。
       而且它和弹窗里那个搜索是同一个功能的两处入口，
       只修一处会让人以为"防抖做了"，其实另一半还在卡。 */
    var sideSearchTimer = null;
    $('searchInput').addEventListener('input', function (e) {
      roomFilter = e.target.value;
      if (sideSearchTimer) clearTimeout(sideSearchTimer);
      sideSearchTimer = setTimeout(renderSidebar, 180);
    });
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

    /* Markdown 里的图片点了要能放大（E-053）。
       CSS 给了 cursor:zoom-in 却没有任何点击处理 ——
       **光标在告诉用户"可以点"，点了却没反应**，
       这比不给 zoom-in 更让人困惑。要么都给，要么都不给。 */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains('md-img')) return;
      if (g.UI && g.UI.lightbox) g.UI.lightbox(t.getAttribute('src') || '');
    });

    /* @ 提及要能点（E-054）。
       渲染时给了蓝底高亮 + data-at，看起来像链接，
       但没有 cursor:pointer 也没有点击处理。
       点一下的效果：把输入框填上 @昵称 —— 这是用户最可能的意图。 */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      if (!t.classList || !t.classList.contains('at-mention')) return;
      var name = t.getAttribute('data-at') || '';
      if (!name) return;
      if (typeof insertAtCursor === 'function') {
        insertAtCursor('@' + name + ' ');
      } else {
        var ta = $('input');
        if (ta) { ta.value += '@' + name + ' '; ta.focus(); }
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { g.UI.closeLightbox(); }
    });
    /* 拖拽发送 */
    var box = $('msgScroll');
    box.addEventListener('dragover', function (e) { e.preventDefault(); });
    box.addEventListener('drop', function (e) {
      e.preventDefault();
      var fs = e.dataTransfer && e.dataTransfer.files;
      if (!fs || !fs.length) return;
      /* ⚠ 原来只取 files[0]，多出来的**静默丢弃**。
         用户一次拖三张图进来，只发出去一张，界面上没有任何提示 ——
         他会以为三张都发了，等对方问"另外两张呢"才发现。
         改成逐个发，并在多文件时给一句提示。 */
      var list = Array.prototype.slice.call(fs);
      if (list.length > 1) g.UI.toast('正在发送 ' + list.length + ' 个文件…', 'ok');
      var i = 0;
      (function next() {
        if (i >= list.length) return;
        var f = list[i++];
        /* ⚠ 不能只按 video 二分（E-060，考古补回）。
           原来写的是 /^video\// ? 'video' : 'image' —— **非视频一律判成图片**。
           拖一个 PDF / zip / docx 进去，它被标成 type='image' 存起来，
           渲染时走 <img> 分支，浏览器解不出来 → 气泡里一块空白。
           用户看到"已发送"，对方收到一个打不开的空图。

           正确的判定是三分：image / video / 其余一律 file。 */
        Promise.resolve(sendMediaFile(f, mediaKindOf(f)))
          .catch(function () { })
          .then(next);
      })();
    });
  }

  /* @ 提及面板：列出本会话成员，点一下插入 @昵称；管理员另有 @全体成员 */
  /* 在输入框光标处插入文本。
     ⚠ 这个函数原来【只有调用、零处定义】（E-056）：
     toggleAtPanel 里每个名字按钮都调它，点任何一个都抛 ReferenceError，
     而抛错发生在 closeTop() 之前，所以面板还不关 ——
     表现为"点人名没反应，面板也关不掉"。@ 功能完全不可用，只能手敲。

     为什么不直接 value += val：
       用户可能把光标放在句子中间（正在写"大家好 @|"），
       追加到末尾会插到错误的位置。必须按 selectionStart/End 拆。 */
  function insertAtCursor(text) {
    var ta = $('input');
    if (!ta) return;
    var v = ta.value || '';
    var a = ta.selectionStart, b = ta.selectionEnd;
    /* 浏览器不支持选区（老 WebView）时退回追加，别整个功能失效 */
    if (typeof a !== 'number' || typeof b !== 'number') { ta.value = v + text; }
    else { ta.value = v.slice(0, a) + text + v.slice(b); }
    /* 光标移到插入内容之后，接着打字才顺手 */
    var pos = (typeof a === 'number' ? a : v.length) + text.length;
    try { ta.setSelectionRange(pos, pos); } catch (e) { }
    ta.focus();
    /* 触发 input 事件：草稿保存、输入框自动增高都挂在它上面，
       不触发的话界面高度不会更新。 */
    try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { }
  }

  /* @提及可点击（E-054）。
     渲染时已经把名字写进 data-at 了，说明本来就打算做成可点的，
     但没有 cursor:pointer、也没有任何点击处理 ——
     用户看到蓝底自然会去点，点了什么反应都没有。

     用事件委托而不是给每个 span 绑 onclick：
     消息节点是缓存复用的（cachedMsgNode），逐条绑定会在复用时重复绑，
     而且翻页/切房间要反复解绑重绑。委托一次挂在容器上就行。 */
  function bindAtMentionClicks() {
    var box = $('msgScroll');
    if (!box || box.__atBound) return;
    box.__atBound = true;
    box.addEventListener('click', function (e) {
      var el = e.target;
      for (var i = 0; el && i < 3; i++) {
        if (el.classList && el.classList.contains('at-mention')) break;
        el = el.parentNode;
      }
      if (!el || !el.classList || !el.classList.contains('at-mention')) return;
      var name = el.getAttribute('data-at') || '';
      if (!name) return;
      if (name === '全体成员') {
        g.UI.toast('@全体成员：会提醒本会话所有人', 'ok');
        return;
      }
      /* 点 @某人 = 把 @名字 插进输入框。
         这是最符合直觉的动作（想回复他就顺手 @ 他），
         比弹一个只能看的资料卡有用。 */
      insertAtCursor('@' + name + ' ');
    });
  }

  function toggleAtPanel() {
    var r = findRoom(cur);
    var list = membersOf(r).filter(function (u) { return u.id !== me.id && u.status !== 'pending'; });
    var d = elc('div', '');
    var box = elc('div', 'chip-box');
    var canAll = (r.owner === me.id || (r.admins || []).indexOf(me.id) >= 0 ||
      me.role === 'owner' || me.role === 'admin');
    var mk = function (text, val) {
      var b = elc('button', 'btn ghost sm', text);
      b.onclick = function () { insertAtCursor(val); g.UI.closeModal(); closeTop(); };
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

  /* ⚠ 原来查 '.modal-mask'，而 ui.js 建的容器是 '.modal-wrap' ——
     同 ui.js closeModal 那个错。**选择器写错不会报错，只会静默失效**，
     所以两处一起错、一起没人发现。 */
  function closeTop() {
    var ms = document.querySelectorAll('.modal-wrap');
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
        /* ⚠ 原来是 value += s，永远追加到末尾（E-094）。
           用户把光标放在句子中间点表情，表情却跑到最后 ——
           他必须再手动剪一段挪回去，等于这个功能没用。
           改成插入到光标处，并保持光标在插入内容之后。 */
        /* ⚠ 已有 insertAtCursor(text) 是**单参数**（E-094-EMOJI，@ 提及那处也在用）。
           这里差点写成两参数版本：那样 text 会拿到 DOM 元素，
           插入的是 "[object HTMLTextAreaElement]" —— 而且不报错。
           同名函数重复定义更危险：会让 @ 提及那两处静默失效。 */
        b.onclick = function () { insertAtCursor(s); p.remove(); $('input').focus(); };
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

    /* 离线补发成功：把界面上那条本地 id 换成服务端 id。
       不换的话，pull 回来的同一条消息（服务端 id）会和本地那条
       （本地生成的 id）id 不同，按 id merge 就会并存 ——
       用户看到自己刚发的话出现两遍（S-043）。 */
    if (g.Online.outboxOnSent) {
      g.Online.outboxOnSent(function (localId, serverId) {
        var done = false;
        Object.keys(S.messages || {}).forEach(function (rid) {
          var arr = S.messages[rid] || [];
          for (var i = 0; i < arr.length; i++) {
            if (arr[i].id === localId) {
              arr[i].id = serverId;
              arr[i].pending = false;
              done = true;
              break;
            }
          }
        });
        if (done) { save(); renderChatSoon(); }
      });
    }

    /* 注册"mediaId → Blob"解码器，让队列能补发媒体（E-055）。
       队列在 localStorage（5 MB），存不下图片本体，
       所以只记 mediaId；补发时由这里从 IndexedDB 取回真实内容。 */
    if (g.Online.outboxSetMediaResolver) {
      g.Online.outboxSetMediaResolver(function (mediaId) {
        if (!g.Media || !g.Media.get) return Promise.resolve(null);
        return g.Media.get(mediaId).then(function (dataUrl) {
          if (!dataUrl) return null;
          return g.Media.toBlob ? g.Media.toBlob(dataUrl) : null;
        }).catch(function () { return null; });
      });
    }

    /* 网络恢复时补发离线队列。
       补发不能只挂在建站初始化那一条路径上 ——
       已登录用户断网再联网是更常见的情况。 */
    if (g.Online.onReconnect) {
      g.Online.onReconnect(function () {
        if (!g.Online.flushOutbox) return;
        g.Online.flushOutbox().then(function (r) {
          var sent = (r && r.sent) || 0, failed = (r && r.failed) || 0;
          if (sent > 0) { g.UI.toast('已补发 ' + sent + ' 条离线消息', 'ok'); save(); renderChatSoon(); }
          if (failed > 0) {
            g.UI.toast('还有 ' + failed + ' 条没发出去'
              + (r.err ? '（' + r.err + '）' : ''), 'err');
            save(); renderChatSoon();
          }
        });
      });
    }

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
    /* ⚠ 原来这里写 `g.I18n.load(g.I18n.detect())`（S-062），
       而 i18n.js 根本没有导出 load / detect 这两个函数 ——
       于是整句是 undefined 调用，抛错后被空 catch 吞掉，
       **多语言初始化静默失败，且没有任何提示**。
       词典写了 290 行、页面一次都没用上，就是这个原因。

       i18n.js 在加载时已经自己跑过 detect() 定语种了，
       这里只需要：① 设置 <html lang>；② apply() 填静态文案。 */
    try {
      if (g.I18n) {
        if (g.I18n.apply) g.I18n.apply();
        try { document.documentElement.lang = g.I18n.get(); } catch (e2) { }
      }
    } catch (e) { }
    /* 语言切换后要能重绘 —— 动态渲染的文案不重绘就不会变 */
    if (g.I18n && g.I18n.apply && g.I18n.set) {
      var _origSet = g.I18n.set;
      g.I18n.set = function (lang) {
        _origSet(lang);
        try { g.I18n.apply(); } catch (e) { }
        try { renderChatSoon(); } catch (e) { }
      };
    }
    initTheme();
    /* 通知模块需要知道"当前在看哪个房间"，才能判断该不该弹 */
    if (g.Notifier) {
      g.Notifier.bindRoom(function () { return cur; });
      g.Notifier.onOpen = function (rid) {
        if (!rid) return;
        openRoom(rid);
      };
    }
    S = load();
    if (!S) { S = fresh(); ensurePublic(); save(true); }
    /* 恢复未读 / @我 / 草稿 —— 不恢复的话上面三样一刷新就清零 */
    if (S.unread) unread = S.unread;
    if (S.atMe) atMe = S.atMe;
    if (S.drafts) drafts = S.drafts;
    bindAtMentionClicks();   /* @提及可点（E-054），容器级委托，绑一次 */
    initSync();
    bootOnline().then(function (handled) {
      if (handled) { g.Online.startPoll(); return; }   /* 在线模式已接管 */
      /* 后端不可用 → 纯本地模式，行为与改动前一致 */
      if (!S.gate) { setupGate(); return; }
      if ((gateOk() ? '1' : '') !== '1') { enterGate(); return; }
      afterGate();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  g.APP = {
    tickMe: tickMe,
    state: function () { return S; },
    me: function () { return me; },
    openRoom: openRoom,
    render: function () { try { renderAll(); } catch (e) { } },
    debugReset: function () { localStorage.removeItem(KEY); location.reload(); }
  };
})(window);
