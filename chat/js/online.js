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
  /* ⚠ 消息专用游标（S-095），**不能与 seq 合并**。
     seq 是全局状态序号（用户/房间/日志共用），推进很快；
     消息分页有自己的进度，被 seq 覆盖就等于把没拉到的消息标成已拉过。 */
  var msgSince = null;
  var timer = null;
  var onStateCb = null;
  var onModeCb = null;

  /* ---------------- 能力探测 ---------------- */

  /* 探测后端是否可达 + 站点是否已初始化。
     失败时降级为本地模式，但必须告知用户 —— 静默回零会让人
     以为自己在云端，实际数据只存在本机浏览器里。 */
  function probe() {
    /* 异常不能抛到 boot() 里把页面搞崩，但要回调通知。 */
    if (!g.SB || typeof g.SB.rpc !== 'function') { notifyMode(false); return Promise.resolve(false); }
    if (g.SB.isOn && !g.SB.isOn()) { notifyMode(false); return Promise.resolve(false); }
    return g.SB.rpc('site_ready', {}).then(function (r) {
      reachable = true;
      online = (r === true || r === 'true' || r === 't');
      notifyMode(online);
      return true;
    }).catch(function () {
      reachable = false; online = false;
      notifyMode(false);
      return false;
    });
  }

  function notifyMode(ok) { if (onModeCb) { try { onModeCb(ok); } catch (e) { } } }

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

  /* gate_check 现在返回 json {ok, token, show_new}。
     show_new 非空表示"用旧密码进来的"，值是新密码明文，交给前端展示。 */
  /* 本机桥接：客户端申领票据 / 网页兑换票据 */
  /* 票据绑定网页来源：申领与兑换必须是同一个 origin，
     否则票据换到别的机器上也能用。 */
  function bridgeTicket(origin) {
    return g.SB.rpc('bridge_ticket_create', { p_origin: origin || '' }).then(function (code) {
      if (!code) throw new Error('未取到票据');
      return code;
    });
  }
  function bridgeRedeem(code, origin) {
    return g.SB.rpc('bridge_ticket_redeem', { p_code: code, p_origin: origin || '' });
  }

  function gate(pwd) {
    return g.SB.rpc('gate_check', { p: pwd }).then(function (r) {
      var t = r && r.token;
      if (!t) throw new Error('保护密码错误');
      g.SB.setSession(t, null);
      return r;
    });
  }

  /* 登录。
     服务端契约已改：凭证类失败【返回 {ok:false, err}】而不是抛异常 ——
     因为 raise 会回滚同一函数内的写入，失败计数根本记不上。
     所以这里必须检查 ok 字段，只看"有没有抛异常"会漏判。 */
  function login(nick, pwd) {
    return g.SB.rpc('user_login', { p_nick: nick, p_pwd: pwd }).then(function (r) {
      if (!r) throw new Error('昵称或密码错误');
      if (r.ok === false) throw new Error(r.err || '登录失败');
      if (!r.token) throw new Error('登录失败');
      g.SB.setSession(r.token, r.uid);
      online = true;
      /* ⚠ 登录后必须拉一次服务端权威权限（E-104，考古补回）。
         syncAcl / ACL.syncFromServer 两个函数都写好了、都导出了，
         **但全仓零处调用** —— 服务端权限从来没同步回前端。
         后果：服务端改了某人的权限（撤掉管理权、加了拒绝项），
         前端仍按本地缓存的角色渲染按钮，用户点下去才被服务端拒绝，
         甚至出现"按钮在、点了报没权限"的割裂。

         失败不阻断登录（syncAcl 内部已 catch 退回本地判定）——
         权限同步失败比登不上好，但要在控制台留一句。 */
      return syncAcl().catch(function () { return null; }).then(function () { return r; });
    });
  }

  /* 权限同步对外封装（E-104）：供登录后与手动刷新时调用 */
  function syncAcl() {
    if (!g.SB || !g.SB.syncAcl) return Promise.resolve(null);
    return g.SB.syncAcl();
  }

  /* ⚠ 第三个参数是"申请说明"（E-058）。
     原签名只有 (nick, pwd)，而注册表单里明摆着有「申请说明」输入框，
     还写着"站长据此决定是否通过" —— 用户认真填了，提交时被丢掉。
     站长那边看到的永远是空的说明，于是只能凭昵称猜。 */
  function register(nick, pwd, note) {
    return g.SB.rpc('user_register',
      { p_nick: nick, p_real: String(note || ''), p_pwd: pwd });
  }

  /* ---------------- 状态转换（服务端 → 前端） ----------------
   * state_get() 返回扁平结构，前端 S.messages 是 {rid: []}，需要转换。
   * 用户/房间/消息字段命名也有差异，这里统一对齐。
   */

  function tUser(u) {
    return {
      /* ⚠ note 原来一律取自 realName（E-086-NOTE），而 realName 是**另一个字段**：
           前端 note  = 用户自己填的「申请说明」
           服务端 real_name = 管理员备注，前端不采集，登录接口也**刻意不返回**
                              （避免实名信息随登录响应外泄）
         服务端既然不返回，这里就恒为 '' —— 于是每次同步，
         用户自己写的申请说明都被静默清空，站长也跟着看不到。
         现在：服务端给了就用，没给（或为空）保持 undefined，
         让上层合并时保留本地已有值，而不是拿空值覆盖。 */
      id: u.id, nick: u.nick, note: (u.realName === undefined || u.realName === null || u.realName === '') ? undefined : u.realName, role: u.role,
      /* ⚠ 原来把 'banned' 映射成 'rejected'（E-076-BANNED）。
         这两个是**完全不同的两件事**：
           banned  = 曾经通过、后来被封禁的正式用户
           rejected = 注册申请被站长打回、从未进过站的人
         混成一个之后，管理面板里一个被封禁的老用户会被当成"申请未通过"的人，
         出现在待审核列表里，还能被"重新通过" —— 等于一条绕开封禁的路。
         所以这里如实保留 banned，前端另有 u.banned 布尔可用。 */
      status: u.status || 'active',
      perms: u.perms || [], banned: u.status === 'banned',
      mutedUntil: u.mutedUntil || 0, bio: u.bio || '',
      createdAt: u.createdAt || 0,
      /* ⚠ updatedAt 用的是 lastSeen —— **语义不对**（S-085）。
         lastSeen 是"最后上线时间"，不是"资料最后修改时间"。
         拿它当版本判据，等于"谁最后上线谁赢"：
         用户只是上线了一下，也会把别人真正的资料修改盖掉。
         保留这一行只为兼容，合并判据请一律用下面的 rev。 */
      updatedAt: u.lastSeen || u.createdAt || 0,
      /* 真正的资料版本（服务端 users.rev，全局单调序号）。
         由 users 表的 insert/update 触发器写入，加列前的老行已回填。 */
      rev: (typeof u.rev === 'number') ? u.rev : null,
      lastSeen: u.lastSeen || 0
    };
  }

  function tRoom(r) {
    return {
      id: r.id, name: r.name, type: r.type, desc: r.desc || '',
      owner: r.owner, admins: r.admins || [], members: r.members || null,
      pwd: r.hasPwd ? '(已设置)' : null, notice: r.notice || '',
      muted: [],
      /* ⚠ 群内禁言从服务端读（S-113）。
         roomMuted 形如 { userId: 到期时间戳毫秒 }，
         服务端只回传**仍在生效**的 —— 所以过期后下一次同步自动解禁，
         不需要前端定时器，也不会出现"界面还禁着、其实早该解了"。
         ⚠ 不能给默认值 {} 以外的值：缺这个字段时应当是"无人被禁言"，
         写成 null 会让 acl.js 的 room.roomMuted[uid] 直接抛 TypeError。 */
      roomMuted: (r.roomMuted && typeof r.roomMuted === 'object') ? r.roomMuted : {},
      /* 被单独关掉邀请权的成员（服务端 can_invite=false） */
      noInvite: r.noInvite || [],
      createdAt: r.createdAt || 0,
      /* ⚠ 原来 updatedAt 直接用 createdAt（S-085，这条最致命）。
         created_at **永远不变**，于是 mergeArr 里
         `x.updatedAt > o.updatedAt` 恒为 false ——
         **房间资料的合并分支从来没执行过**：
         服务端改了房间名/公告，前端同步回来时被整个丢弃。
         这正是"改公告不同步""置顶只改本地"那一族问题的共同根因 ——
         不是没调服务端，是调了、存了、返回了，被前端判据丢掉了。 */
      updatedAt: r.createdAt || 0,
      /* 真正的资料版本（服务端 rooms.rev）。加列前的老房间已回填。 */
      rev: (typeof r.rev === 'number') ? r.rev : null
    };
  }

  function tMsg(m) {
    return {
      id: m.id, room: m.room, from: m.from, type: m.type,
      text: m.text || '', mediaId: m.mediaId || null,
      name: m.name || '', size: m.size || 0,
      replyTo: m.replyTo || null, deleted: !!m.deleted, ts: m.ts || 0,
      editedAt: m.edited ? Date.parse(m.edited) || 0 : 0
    };
  }

  /* 服务端时钟与本机时钟的偏差（E-049 / S-065）。
     在线判定时不能拿 Date.now() 直接比服务端的 last_seen ——
     本机钟快 5 分钟，所有人的 last_seen 都落在窗口外 → 全员显示离线；
     本机钟慢 → 全员显示在线，且撤回时限形同虚设。

     拿到服务端时间后算出 offset，之后凡是与服务端时间戳比较的地方
     都用 serverNow() 代替 Date.now()。 */
  var clockOffset = 0;
  function noteServerTime(t) {
    if (!t) return;
    clockOffset = t - Date.now();
    /* 偏差超过 60 秒就值得记一笔：通常意味着用户系统时间没同步 */
    if (Math.abs(clockOffset) > 60000) {
      try { console.warn('[clock] 本机与服务端时间相差 '
        + Math.round(clockOffset / 1000) + ' 秒，已按服务端时间校正'); } catch (e) { }
    }
  }
  /* 校正后的"现在"。用于一切与服务端时间戳的比较。 */
  function serverNow() { return Date.now() + clockOffset; }

  /* 把服务端整包 state 转成前端 mergeState() 能吃的结构 */
  function convert(j) {
    if (!j) return null;
    var out = { users: [], rooms: [], messages: {}, logs: [] };
    if (j.serverNow) noteServerTime(j.serverNow);
    if (j.rev != null) out.rev = j.rev;
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
      /* Q-Chat-S-120：无门模式。
         服务端取消了站点保护密码 —— 前端必须据此跳过密码框，
         否则用户会卡在一个"请输入保护密码"的页面上，
         而那个密码此刻在服务端已经不存在了，怎么输都不对。
         这种"门已拆、牌子还挂着"的状态最让人困惑：
         他会以为自己记错了密码，反复重试。 */
      out.gateOff = !!j.site.gate_off;
    }
    /* 服务端已初始化 → 本地门禁标记为真，避免再弹本地门禁 */
    out.gate = { hash: 'server', salt: 'server' };
    return out;
  }

  /* ---------------- 拉取 ----------------
   * 首次用 state_get() 全量；之后一律 state_delta(since) 增量。
   * 全量轮询的代价：一个人发一句话，N 个在线客户端各拉一次全站（30 天消息 + 200 日志），
   * N×N 增长 —— 免费额度层面唯一还开着的水龙头。
   */

  /* ⚠ 消息分页循环（S-095）。
     服务端每次最多给 500 条消息，剩下用 msgCursor 继续要。
     ⚠ 关键：**消息游标 msgSince 必须独立于全局 seq 保存**。
        用 seq 覆盖它，就等于把没拉到的那批标记为"已拉过" ——
        下一次从新 seq 开始，中间那些**永远拉不到了**。
        这是"截断 + 游标推进"最典型的静默丢失，必须避开。

     循环上限 50 轮（最多 2.5 万条）：
       真有那么多消息时，与其卡在循环里，不如先让用户看到最近的，
       剩下的下次轮询继续补。设上限也是防止服务端异常时无限打下去。 */
  var MSG_PAGE_MAX = 50;

  function pull() {
    return g.SB.rpc('state_get', {}).then(function (j) {
      var s = convert(j);
      if (s && j && typeof j.rev === 'number') seq = j.rev;
      if (j && typeof j.msgCursor === 'number') msgSince = j.msgCursor;
      if (s && onStateCb) onStateCb(s);
      if (!(j && j.msgMore)) return s;
      return pullMoreMessages(1).then(function () { return s; });
    });
  }

  /* 继续往前补更旧的消息（state_get 给的游标是这批里最旧的 rev） */
  function pullMoreMessages(round) {
    if (round > MSG_PAGE_MAX) return Promise.resolve();
    return g.SB.rpc('state_delta', { p_since: msgSince || 0 }).then(function (j) {
      if (j && typeof j.msgCursor === 'number') msgSince = j.msgCursor;
      var s = convert(j);
      if (s && onStateCb) onStateCb(s);
      if (!(j && j.msgMore)) return null;
      return pullMoreMessages(round + 1);
    }).catch(function () { return null; });
  }

  /* 增量拉取：只取上次之后变化的部分 */
  function pullDelta() {
    return g.SB.rpc('state_delta', { p_since: seq || 0 }).then(function (j) {
      if (j && typeof j.rev === 'number') seq = j.rev;
      if (j && typeof j.msgCursor === 'number') msgSince = j.msgCursor;
      var s = convert(j);
      if (s && onStateCb) onStateCb(s);
      if (!(j && j.msgMore)) return s;
      /* 增量也分页：离线很久回来时，一次可能拉不完 */
      return pullMoreMessages(1).then(function () { return s; });
    });
  }

  /* 轮询：只比序号，变了才拉全量。
     必须用 state_peek 而不是 state_seq —— 后者是 nextval，会自己把序号改掉。 */
  /* 后台降频：页面不可见时把轮询拉长到 30 秒。
     手机上一晚上挂着不动，4 秒一次就是两万多次请求 ——
     纯粹烧额度，用户什么也没得到。回到前台立刻恢复。 */
  var HIDDEN_MS = 30000;
  var visibleMs = 4000;
  var hidden = false;

  function startPoll(intervalMs) {
    stopPoll();
    visibleMs = intervalMs || 4000;
    bindVisibility();
    timer = setInterval(tick, curInterval());
  }

  function curInterval() { return hidden ? HIDDEN_MS : visibleMs; }

  /* 上次轮询是否成功。用来检测"网络恢复"。
     ⚠ 必须检测，否则补发只在建站初始化时发生一次：
       已登录用户中途断网发的消息，重新联网后永远不会被补发，
       一直挂着"待发送"不动 —— 队列机制等于白做。 */
  var tickOk = false;
  var reconnectHandler = null;
  function onReconnect(fn) { reconnectHandler = fn; }

  function tick() {
    if (!online || !g.SB || !g.SB.token()) return;
    g.SB.rpc('state_peek', {}).then(function (n) {
      /* 失败→成功：网络刚恢复，把离线期间攒的消息补发出去 */
      if (!tickOk) {
        tickOk = true;
        if (reconnectHandler) { try { reconnectHandler(); } catch (e) { } }
      }
      n = Number(n);
      if (seq === null) { seq = n; return pull(); }   /* 首次建立基线 */
      if (n !== seq) { seq = n; return pullDelta(); } /* 之后只拉增量 */
    }).catch(function () {
      tickOk = false;   /* 网络抖动忽略，但记下来，好在恢复时补发 */
    });
  }

  var visBound = false;
  function bindVisibility() {
    if (visBound || typeof document === 'undefined') return;
    visBound = true;
    document.addEventListener('visibilitychange', function () {
      var nowHidden = !!document.hidden;
      if (nowHidden === hidden) return;
      hidden = nowHidden;
      /* 回到前台：立刻拉一次，别让用户等一个周期才看到新消息 */
      if (!hidden && online) { tick(); }
      if (timer) { clearInterval(timer); timer = setInterval(tick, curInterval()); }
    });
  }

  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  /* ---------------- 离线消息队列 ----------------
     离线时发的消息先存本地，联网后按序补发。
     时间戳由服务端给 —— 本机时钟可能不准，用它会导致消息乱序，
     插在别人消息中间，看起来非常怪。

     所以客户端只管排队，不自己造时间戳。

     ⚠ 上限不是"以防万一"，是必需的：
       localStorage 只有 5MB。长期离线会攒爆，届时 setItem 抛异常
       被 try/catch 吞掉 —— 用户看到"已存入待发送队列"，
       实际一条都没存住。攒爆之后入队的消息全部静默丢失，
       这比当场告诉用户"存不下了"糟得多（S-045）。 */
  var OUTBOX_KEY = 'chat_outbox';
  var OUTBOX_MAX_ITEMS = 200;                    /* 条数上限 */
  var OUTBOX_MAX_BYTES = 2 * 1024 * 1024;        /* 体积上限 2MB（配额 5MB） */
  var OUTBOX_TTL_MS = 7 * 24 * 3600 * 1000;      /* 7 天以上就没什么意义了 */

  function outbox() {
    try {
      var v = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
      /* ⚠ 原来只 try 了 JSON.parse 的语法错误，没校验结果类型。
         localStorage 里存的是 `null`、`{}`、`"abc"` 时 parse 不抛错，
         返回的不是数组 —— 后面 list.push / list.filter 直接 TypeError，
         表现为"一发消息就崩"，而崩在队列里，用户根本不知道为什么。
         这个 key 是用户可改的（开发者工具里手改、别的脚本写脏）。 */
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function outboxBytes(list) {
    try { return JSON.stringify(list).length; } catch (e) { return 0; }
  }

  /* 返回是否真的存住了 —— 存不下必须让调用方知道，不能静默 */
  function outboxSave(list) {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); return true; }
    catch (e) { return false; }
  }

  /* 入队。
     localId 是界面上那条乐观更新消息的本地 id —— 补发成功要靠它
     把本地临时 id 换成服务端 id，否则同一条会出现两遍（S-043）。

     返回 { ok, qid, dropped, reason }：
       ok=false 表示真的没存住，界面必须如实告诉用户，
       不能照样显示"待发送"（那是在骗人）。 */
  function enqueue(item) {
    var now = Date.now();
    var list = outbox();

    /* 先清过期的 */
    var before = list.length;
    list = list.filter(function (x) {
      return !x.queuedAt || (now - x.queuedAt) < OUTBOX_TTL_MS;
    });
    var dropped = before - list.length;

    item.qid = 'q_' + now + '_' + Math.random().toString(36).slice(2, 8);
    item.queuedAt = now;
    list.push(item);

    /* 超上限就丢最老的。while 里保底留 1 条 ——
       刚点的发送必须留下，否则用户点完什么都没有，非常费解。 */
    while (list.length > OUTBOX_MAX_ITEMS && list.length > 1) { list.shift(); dropped++; }
    while (outboxBytes(list) > OUTBOX_MAX_BYTES && list.length > 1) { list.shift(); dropped++; }

    if (!outboxSave(list)) {
      /* 存不下（配额满）。把刚加的这条去掉再试一次，至少保住已有的 */
      list.pop();
      outboxSave(list);
      return { ok: false, qid: null, dropped: dropped, reason: 'quota' };
    }
    return { ok: true, qid: item.qid, dropped: dropped, reason: null };
  }

  /* ⚠ 原来不返回、也不检查保存结果（S-043 的残留）。
     发送成功后调 dequeue 把它从队列里去掉 ——
     但如果 localStorage 写不进去（配额满），**它其实没被去掉**，
     而调用方已经 sent++、界面提示"已补发 N 条"。
     下次联网再 flush，同一条消息会**再发一遍** —— 对方收到两条一模一样的。

     所以：① 返回是否真删掉了；② 删不掉时给这条打标记，
     下次 flush 跳过它，只尝试再清理一次。
     不打标记的话它会每次联网都重发，无限刷屏。 */
  function dequeue(qid) {
    var list = outbox().filter(function (x) { return x.qid !== qid; });
    return outboxSave(list);
  }

  /* 发送成功但没能出队：标记它，避免下次重复发送 */
  function markStuck(qid) {
    var list = outbox();
    var hit = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].qid === qid) { list[i]._sentNoDeq = true; hit = true; }
    }
    if (hit) outboxSave(list);
    return hit;
  }

  /* 补发成功后通知界面：把本地临时 id 换成服务端 id。
     不做这一步会怎样（S-043）：
       界面那条是乐观更新出来的，id 由本地生成；补发时服务端另生成一个。
       pull 回来后两条 id 不同，按 id merge 就会并存 ——
       用户看到自己发的话出现两遍。 */
  var outboxSentHandler = null;
  function outboxOnSent(fn) { outboxSentHandler = fn; }

  /* 媒体补发需要一个"mediaId → Blob"的解码器（E-055）。
     媒体本体存在 IndexedDB（可以几十 MB），
     而队列在 localStorage（总共 5 MB）——
     **所以队列里只能放 mediaId，不能放 dataUrl。**
     补发时再按 id 取回本体上传。
     这里不直接依赖 Media 模块，由 app.js 注册进来，层不反。 */
  var mediaBlobResolver = null;
  function outboxSetMediaResolver(fn) { mediaBlobResolver = fn; }

  /* 补发。按顺序逐条发 ——
     顺序错了比少发一条更糟，所以不能并发。

     ⚠ 失败不能静默（S-044）：
       之前 .catch 什么都不做，用户不知道有几条没发出去、为什么。
       攒了 50 条全失败，它们还挂着"待发送"，用户以为迟早会发出去。
     返回 { sent, failed, err }。 */
  function flushOutbox() {
    var empty = { sent: 0, failed: 0, err: null };
    if (!online) return Promise.resolve(empty);
    var list = outbox().filter(function (x) { return !x._sentNoDeq; });
    if (!list.length) return Promise.resolve(empty);

    var sent = 0, failed = 0, lastErr = null;
    var chain = Promise.resolve();
    list.slice().forEach(function (it) {
      chain = chain.then(function () {
        /* 媒体消息：补发前先上传本体（E-055）。
           离线时发图发视频根本没进队列 —— 在线后也不会补发，
           对方永远收不到，而本机看着"已发送"。
           顺序不能反：必须先上传拿 path，再发消息带 path。 */
        var prep = Promise.resolve();
        if (it.mediaId && !it.media && mediaBlobResolver) {
          prep = mediaBlobResolver(it.mediaId).then(function (blob) {
            if (!blob) throw new Error('媒体已不在本机');
            return g.Online.uploadMedia(it.room, it.name || '', blob);
          }).then(function (slot) {
            it.media = slot.path;
          });
        }
        return prep.then(function () {
        return g.SB.rpc('msg_send', {
          p_room: it.room, p_type: it.type, p_body: it.body,
          p_media: it.media || null, p_name: it.name || '',
          p_size: it.size || 0, p_reply: it.replyTo || null
        }).then(function (res) {
          var removed = dequeue(it.qid);
          if (outboxSentHandler && it.localId && res && res.id) {
            try { outboxSentHandler(it.localId, res.id, it); } catch (e) { }
          }
          if (removed) {
            sent++;
          } else {
            /* 发出去了，但没从队列里删掉 —— 必须打标记，
               否则下次 flush 会再发一次，对方看到两条一样的。
               同时不能算进 sent（那样界面会说"已补发"而实际有隐患），
               也不能算 failed（消息其实发出去了）。单独记一笔。 */
            markStuck(it.qid);
            failed++;
            lastErr = '已发出，但队列清理失败（存储已满）—— 请清理空间，否则可能重复发送';
          }
        });
        }).catch(function (e) {
          failed++;
          lastErr = (e && e.message) ? e.message : '网络错误';
        });
      });
    });
    return chain.then(function () {
      return { sent: sent, failed: failed, err: lastErr };
    });
  }

  /* ---------------- 写操作：只走带鉴权的 RPC ----------------

     ⚠ 前端一律走这里的封装，不要直接 g.SB.rpc（S-019）。
     理由不是"统一风格"，是三件具体的事：
       1. 这里能统一判断在线状态，离线时给出一致的失败而不是各写各的
       2. 失败能被统一报出来 —— 直接 g.SB.rpc 的地方有 3 处写成
          .catch(function () { })，出错完全无声，用户只知道"点了没反应"
       3. 将来加鉴权头 / 重试，只改这一处 */

  /* 管理操作：封禁 / 解封 / 删号。
     这三个原来在 app.js 里直接调 g.SB.rpc 且静默吞异常 ——
     管理员点了"封禁"，请求失败了，界面却毫无反应，
     他会以为已经封了。 */
  function userReview(uid, status) {
    return g.SB.rpc('user_review', { p_user: uid, p_status: status });
  }
  function userDelete(uid) {
    return g.SB.rpc('user_delete', { p_user: uid });
  }
  /* 邀请码：必须走服务端。
     原来口令存在本地 S.invites —— 在 A 机器生成的码，B 机器输入说"不存在"。
     邀请码是要发给别人的，天生跨设备、跨人，本地存就只在生成那台成立。 */
  /* custom 为自定义口令（INV-CUSTOM，可空）。服务端会校验权限与合法性，
     前端只是把输入传过去 —— 校验必须以服务端为准。 */
  function inviteCreate(room, hours, maxUse, custom) {
    /* p_code **总是要传**（本次踩坑）：
       服务端已 drop 掉 3 参数签名，只留 4 参数版。
       如果这里 custom 为空就不传，调用会退化成 3 参数 → 找不到函数。 */
    var args = { p_room: room, p_hours: hours || 0, p_max_use: maxUse || 0, p_code: custom ? String(custom) : '' };
    return g.SB.rpc('invite_create', args);
  }
  function inviteRedeem(code) {
    /* 不再 toUpperCase：自定义口令是小写，
       大小写兼容交给服务端（同时查 lower 与 upper）。 */
    return g.SB.rpc('invite_redeem', { p_code: String(code || '').trim() });
  }
  function inviteRevoke(code) {
    return g.SB.rpc('invite_revoke', { p_code: String(code || '').toUpperCase() });
  }
  /* ⚠ 列出已生成的邀请码（E-089，考古补回）。
     inviteRevoke 导出后全仓零处调用，就因为没有任何界面能列出口令 ——
     看不见的东西自然没法操作。生成一个"长期·不限次数"的口令后，
     就再也没有任何办法收回它。 */
  function inviteList() {
    return g.SB.rpc('invite_list', {});
  }
  /* 开关某个成员"能不能邀请别人" */
  function setCanInvite(room, uid, can) {
    return g.SB.rpc('member_set_can_invite',
      { p_room: room, p_user: uid, p_can: !!can });
  }
  /* 给已有消息补上媒体（媒体异步上传完再回填） */
  function msgMedia(msgId, path) {
    return g.SB.rpc('msg_media', { p_msg: msgId, p_media: path });
  }
  /* 改密码（S-011）：服务端会报"原密码错误"/"至少 4 位"，
     必须由调用方显示 e.message —— 这两条错误之前无处显示。 */
  /* 改昵称 / 个性签名 / 真实姓名。
     服务端 profile_update 早就有了，前端却没接 ——
     /nick 命令只改本地 me.nick，弹一句"修改了昵称"就完事，
     在线模式下刷新即回滚，其他设备完全不知道。
     **界面说了"已修改"，实际没改 —— 这比不支持更糟。** */
  function profileUpdate(o) {
    o = o || {};
    return g.SB.rpc('profile_update', {
      p_nick: o.nick === undefined ? null : o.nick,
      p_real: o.real === undefined ? null : o.real,
      p_bio: o.bio === undefined ? null : o.bio
    });
  }

  function changePwd(oldP, newP) {
    return g.SB.rpc('user_password', { p_old: oldP, p_new: newP });
  }



  function sendMsg(room, type, body, media, name, size, replyTo) {
    return g.SB.rpc('msg_send', {
      p_room: room, p_type: type, p_body: body || '',
      p_media: media || null, p_name: name || '', p_size: size || 0,
      p_reply: replyTo || null
    });
  }

  /* 编辑自己的消息。服务端只允许本人改自己的 —— 改别人的属于伪造发言。 */
  function editMsg(id, body) {
    return g.SB.rpc('msg_edit', { p_id: id, p_body: body }).then(function () { return true; });
  }

  /* ⚠ 撤回必须调服务端（S-082，考古找回）。
     服务端的 msg_delete 早就写好了（含自己的 5 分钟时限、
     别人的 msg.remove 权限点、审计日志），**但前端从未调用过它** ——
     doRemove 只改本地 m.deleted 然后 save()。

     后果：界面弹「已撤回」，其他人那里消息原样在。
     **撤回是带时效承诺的操作：用户以为 5 分钟内撤回了，
     实际上对方永远看得到，而且自己下次拉取还会被服务端覆盖回来。**

     这是"服务端备好了、前端没接"，跟 changePwd、data-mid 同一族。 */
  function deleteMsg(id) {
    if (!isOnline()) return Promise.resolve(false);
    return g.SB.rpc('msg_delete', { p_id: id }).then(function () { return true; });
  }

  /* ---------------- 房间 ----------------
   * 建群/改群名/加人/踢人/设管理员：一律走带鉴权的 RPC。
   * 不能整包写回（state_put 在服务端不存在，且会绕过全部权限校验）。
   */
  function createRoom(name, desc, pwd) {
    return g.SB.rpc('room_create', { p_name: name, p_desc: desc || '', p_pwd: pwd || null });
  }
  function updateRoom(rid, name, desc, notice) {
    return g.SB.rpc('room_update', { p_room: rid, p_name: name, p_desc: desc, p_notice: notice });
  }
  function joinRoom(rid, pwd) {
    return g.SB.rpc('room_join', { p_room: rid, p_pwd: pwd || null });
  }
  function addMember(rid, userId) {
    return g.SB.rpc('member_add', { p_room: rid, p_user: userId });
  }
  function removeMember(rid, userId) {
    return g.SB.rpc('member_remove', { p_room: rid, p_user: userId });
  }
  /* 禁言。minutes<=0 表示解除。 */
  function setMute(userId, minutes) {
    return g.SB.rpc('user_mute', { p_user: userId, p_minutes: minutes || 0 });
  }
  /* ⚠ 群内禁言（S-113）。
     与 setMute（全站）是两个不同的 RPC、两个不同的权限点 ——
     不能互相替代：用 room_mute 传全站语义会让群主越权，
     用 user_mute 做群内禁言则是"在群里操作却全站生效"（E-069）。
     minutes<=0 表示解除。 */
  function setRoomMute(roomId, userId, minutes) {
    return g.SB.rpc('room_mute',
      { p_room: roomId, p_user: userId, p_minutes: (minutes > 0 ? minutes : 0) });
  }
  /* 权限矩阵：授予 / 撤销单个权限点 */
  function setPerms(userId, perms, denied) {
    return g.SB.rpc('user_perms_set', {
      p_user: userId, p_perms: perms || [], p_denied: denied || []
    });
  }
  function setRole(userId, role) {
    return g.SB.rpc('user_role_set', { p_user: userId, p_role: role });
  }

  function setAdmin(rid, userId, on) {
    return g.SB.rpc('member_admin', { p_room: rid, p_user: userId, p_on: on !== false });
  }

  /* ---------------- 媒体 ----------------
   * 桶是私有的，且本项目用自建会话（拿不到 Supabase Auth 的 JWT），
   * 所以上传走"先申请槽位 → anon 上传 → 提交"三步。
   * 任一步失败都退回本地 IndexedDB，并明确告知用户。
   */
  function prepareMedia(room, name, size) {
    return g.SB.rpc('media_prepare', { p_room: room, p_name: name, p_size: size });
  }
  function commitMedia(id) {
    return g.SB.rpc('media_commit', { p_id: id });
  }
  function mediaUrl(id, exp) {
    return g.SB.rpc('media_url', { p_id: id, p_exp: exp || 3600 });
  }

  /* 完整上传：申请 → 上传字节 → 提交。返回 {id, path}，失败抛错。 */
  function uploadMedia(room, name, blob) {
    if (!g.SB || !g.SB.uploadToStorage) return Promise.reject(new Error('上传不可用'));
    var slot = null;
    return prepareMedia(room, name, blob.size || 0).then(function (r) {
      slot = r;
      return g.SB.uploadToStorage(r.path, blob);
    }).then(function () {
      return commitMedia(slot.id);
    }).then(function () {
      return slot;
    });
  }

  /* ---------------- 接入 ---------------- */

  function init(handlers) {
    onStateCb = handlers && handlers.onState;
    onModeCb = handlers && handlers.onMode;

    /* 媒体远端解析：本地 IndexedDB 里没有的媒体（换设备、清缓存），
       去服务端换签名 URL。桶是私有的，不能直接拼公开链接。 */
    if (g.Media && g.Media.setRemoteResolver) {
      g.Media.setRemoteResolver(function (id) {
        /* id 可能是 storage 路径（room/uid/uuid），也可能是本地 id */
        if (!id || String(id).indexOf('/') < 0) return Promise.resolve(null);
        return g.SB.rpc('media_url_by_path', { p_path: String(id) })
          .then(function (u) { return u || null; })
          .catch(function () { return null; });
      });
    }
    return probe();
  }

  g.Online = {
    bridgeTicket: bridgeTicket,
    bridgeRedeem: bridgeRedeem,
    init: init, probe: probe, isOnline: isOnline, isReachable: isReachable,
    setup: setup, gate: gate, login: login, register: register, syncAcl: syncAcl,
    pull: pull, pullDelta: pullDelta, startPoll: startPoll, stopPoll: stopPoll,
    createRoom: createRoom, updateRoom: updateRoom, joinRoom: joinRoom,
    userReview: userReview, userDelete: userDelete, msgMedia: msgMedia,
    inviteCreate: inviteCreate, inviteRedeem: inviteRedeem,
    inviteRevoke: inviteRevoke, inviteList: inviteList, setCanInvite: setCanInvite,
    changePwd: changePwd, profileUpdate: profileUpdate,
    addMember: addMember, removeMember: removeMember, setAdmin: setAdmin,
    setRoomMute: setRoomMute,
    setMute: setMute, setPerms: setPerms, setRole: setRole,
    prepareMedia: prepareMedia, commitMedia: commitMedia, mediaUrl: mediaUrl,
    uploadMedia: uploadMedia,
    sendMsg: sendMsg, editMsg: editMsg, deleteMsg: deleteMsg, convert: convert,
    joinRoom: joinRoom, createRoom: createRoom, updateRoom: updateRoom,
    enqueue: enqueue, flushOutbox: flushOutbox, outbox: outbox, dequeue: dequeue,
    outboxOnSent: outboxOnSent, outboxSetMediaResolver: outboxSetMediaResolver,
    serverNow: serverNow, clockOffset: function () { return clockOffset; },
    onReconnect: onReconnect
  };
})(window);
