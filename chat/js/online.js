/* ------------------------------------------------------------------
 * online.js —— 在线模式（服务端为权威）
 *
 * 背景：原本 data 只存在浏览器 localStorage，"多人聊天"实际是同机多标签。
 *       服务端（Supabase）建好后，前端仍完全没有联网代码 —— 后端是空的。
 *       本模块补上这段：认证 + 拉取 + 发消息 走服务端，本地只做缓存与渲染。
 *
 * 职责边界（重要，别越界）：
 *   服务端权威 = 账号、房间、消息、权限
 *   前端保留   = 渲染、草稿、UI 偏好（这些本来也不该上服务器）
 *
 * 不是"整包 push"：
 *   sb.js 里的 state_put 在服务端其实【不存在】（调用了会 404）。
 *   这不是遗漏而是对的 —— 让客户端整包写回服务端，等于绕过全部权限校验。
 *   所以写操作只走粒度化 RPC（msg_send / room_create / ...），
 *   每个 RPC 内部自带鉴权。
 *
 * 读取走 state_get() 整包拉取，再按 id/时间 merge 进本地 state。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var online = false;      // 后端可用且站点已初始化
  var reachable = false;   // 后端能连上（不一定已初始化）
  var seq = null;          // 上次看到的序号
  var timer = null;
  var onStateCb = null;

  /* ---------------- 能力探测 ---------------- */

  /* 探测后端是否可达 + 站点是否已初始化。
     失败一律降级为本地模式，绝不阻断用户使用。 */
  function probe() {
    /* 后端不可用必须静默降级：缺 SB、缺 rpc、连不上，都只是退回本地模式，
       绝不能把异常抛到 boot() 里把整个页面搞崩。 */
    if (!g.SB || typeof g.SB.rpc !== 'function') return Promise.resolve(false);
    if (g.SB.isOn && !g.SB.isOn()) return Promise.resolve(false);
    return g.SB.rpc('site_ready', {}).then(function (r) {
      reachable = true;
      online = (r === true || r === 'true' || r === 't');
      return true;
    }).catch(function () {
      reachable = false; online = false;
      return false;
    });
  }

  function isOnline() { return online; }
  function isReachable() { return reachable; }

  /* ---------------- 认证 ---------------- */

  /* 站点初始化：设置保护密码 + 建站长账号 */
  function setup(gate, nick, pwd) {
    return g.SB.rpc('site_init', { p_gate: gate, p_nick: nick, p_real: '', p_pwd: pwd })
      .then(function (r) {
        if (r && r.token) g.SB.setSession(r.token, r.uid);
        online = true;
        return r;
      });
  }

  function gate(pwd) {
    return g.SB.rpc('gate_check', { p: pwd }).then(function (t) {
      if (!t) throw new Error('保护密码错误');
      g.SB.setSession(t, null);
      return t;
    });
  }

  function login(nick, pwd) {
    return g.SB.rpc('user_login', { p_nick: nick, p_pwd: pwd }).then(function (r) {
      if (!r) throw new Error('昵称或密码错误');
      g.SB.setSession(r.token, r.uid);
      online = true;
      return r;
    });
  }

  function register(nick, pwd) {
    return g.SB.rpc('user_register', { p_nick: nick, p_real: '', p_pwd: pwd });
  }

  /* ---------------- 状态转换（服务端 → 前端） ----------------
   * state_get() 返回扁平结构，前端 S.messages 是 {rid: []}，需要转换。
   * 用户/房间/消息字段命名也有差异，这里统一对齐。
   */

  function tUser(u) {
    return {
      id: u.id, nick: u.nick, note: u.realName || '', role: u.role,
      status: u.status === 'banned' ? 'rejected' : (u.status || 'active'),
      perms: u.perms || [], banned: u.status === 'banned',
      mutedUntil: u.mutedUntil || 0, bio: u.bio || '',
      createdAt: u.createdAt || 0, updatedAt: u.lastSeen || u.createdAt || 0,
      lastSeen: u.lastSeen || 0
    };
  }

  function tRoom(r) {
    return {
      id: r.id, name: r.name, type: r.type, desc: r.desc || '',
      owner: r.owner, admins: r.admins || [], members: r.members || null,
      pwd: r.hasPwd ? '(已设置)' : null, notice: r.notice || '',
      muted: [], createdAt: r.createdAt || 0, updatedAt: r.createdAt || 0
    };
  }

  function tMsg(m) {
    return {
      id: m.id, room: m.room, from: m.from, type: m.type,
      text: m.text || '', mediaId: m.mediaId || null,
      name: m.name || '', size: m.size || 0,
      replyTo: m.replyTo || null, deleted: !!m.deleted, ts: m.ts || 0
    };
  }

  /* 把服务端整包 state 转成前端 mergeState() 能吃的结构 */
  function convert(j) {
    if (!j) return null;
    var out = { users: [], rooms: [], messages: {}, logs: [] };
    (j.users || []).forEach(function (u) { out.users.push(tUser(u)); });
    (j.rooms || []).forEach(function (r) { out.rooms.push(tRoom(r)); });
    (j.messages || []).forEach(function (m) {
      var x = tMsg(m);
      (out.messages[x.room] || (out.messages[x.room] = [])).push(x);
    });
    (j.logs || []).forEach(function (l) {
      out.logs.push({ id: l.id, who: l.who, act: l.act, detail: l.detail, target: l.target, ts: l.ts || 0 });
    });
    if (j.site) {
      out.siteName = j.site.site_name;
      if (typeof j.site.allow_register === 'boolean') out.allowRegister = j.site.allow_register;
    }
    /* 服务端已初始化 → 本地门禁标记为真，避免再弹本地门禁 */
    out.gate = { hash: 'server', salt: 'server' };
    return out;
  }

  /* ---------------- 拉取 ---------------- */

  function pull() {
    return g.SB.rpc('state_get', {}).then(function (j) {
      var s = convert(j);
      if (s && onStateCb) onStateCb(s);
      return s;
    });
  }

  /* 轮询：只比序号，变了才拉全量。
     必须用 state_peek 而不是 state_seq —— 后者是 nextval，会自己把序号改掉。 */
  function startPoll(intervalMs) {
    stopPoll();
    intervalMs = intervalMs || 4000;
    timer = setInterval(function () {
      if (!online || !g.SB || !g.SB.token()) return;
      g.SB.rpc('state_peek', {}).then(function (n) {
        n = Number(n);
        if (seq === null) { seq = n; return; }
        if (n !== seq) { seq = n; return pull(); }
      }).catch(function () { /* 网络抖动忽略，下次再来 */ });
    }, intervalMs);
  }

  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  /* ---------------- 写操作：只走带鉴权的 RPC ---------------- */

  function sendMsg(room, type, body, media, name, size, replyTo) {
    return g.SB.rpc('msg_send', {
      p_room: room, p_type: type, p_body: body || '',
      p_media: media || null, p_name: name || '', p_size: size || 0,
      p_reply: replyTo || null
    });
  }

  /* ---------------- 接入 ---------------- */

  function init(handlers) {
    onStateCb = handlers && handlers.onState;
    return probe();
  }

  g.Online = {
    init: init, probe: probe, isOnline: isOnline, isReachable: isReachable,
    setup: setup, gate: gate, login: login, register: register,
    pull: pull, startPoll: startPoll, stopPoll: stopPoll,
    sendMsg: sendMsg, convert: convert
  };
})(window);
