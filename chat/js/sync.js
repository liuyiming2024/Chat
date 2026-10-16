/* ------------------------------------------------------------------
 * sync.js —— 统一同步层（全项目唯一的同步架构）
 *
 * 架构约定（本地版与 GitHub Pages 上线版完全一致，不存在第二种运行形态）：
 *
 *   唯一数据源  = 浏览器内的 state 对象（内存）
 *   持久化      = localStorage 存状态快照，IndexedDB 存图片/视频
 *   跨标签同步  = BroadcastChannel 广播 + storage 事件（同源内多标签即多人）
 *   收敛策略    = 任何一份 state 进来都走同一套 merge（按 id 去重、按时间取新、
 *                 删除标记不可逆），不以"服务端权威"或"本地权威"区分
 *
 * 本模块不区分 file:// / http:// / Pages，也不存在"在线/离线"两套逻辑：
 * 浏览器支持 BroadcastChannel 就多标签实时同步，不支持就退化为单标签会话，
 * 这是同一套代码在浏览器能力上的自然表现，而非架构分支。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var CHANNEL = 'wxlg_sync_v1';
  var bc = null;
  var onTypingCb = null;
  var stateKey = null;      /* 状态快照的 localStorage key，由 init 传入 */
  var onStateCb = null;      // 收到他人/他标签的 state 时回调
  var onPatchCb = null;      // 收到单条消息时回调（轻量提示）
  var selfId = (g.SHA256 && g.SHA256.randomId) ? g.SHA256.randomId(8) : String(Math.random()).slice(2);

  function supported() {
    return typeof g.BroadcastChannel !== 'undefined';
  }

  /* ---------- 初始化：监听同源内其他标签的变更 ---------- */
  function init(handlers) {
    onStateCb = handlers && handlers.onState;
    onPatchCb = handlers && handlers.onPatch;
    /* ⚠ typing 回调必须在这里接（E-061，考古补回）。
       app.js 的 markTyping 取的是 g.__syncBc，而这个变量**全仓只有那一处读取、
       零处赋值** —— bc 是本模块私有变量，init() 的返回值 app.js 也没接收。
       于是"正在输入"广播发出去的是 undefined，postMessage 根本没执行，
       被 try/catch 静默吞掉。

       同时 showTyping() 定义了但**零处调用** —— 就算广播到了也没人显示。
       两处任一断掉，这个功能就从未运行过一次。
       现在统一由本模块提供发送与接收。 */
    onTypingCb = handlers && handlers.onTyping;
    /* 传了就只监听这一个 key；没传才退回宽松的前缀匹配（兼容旧调用） */
    stateKey = (handlers && handlers.stateKey) || null;

    if (supported()) {
      try {
        bc = new BroadcastChannel(CHANNEL);
        bc.onmessage = function (e) {
          var d = e.data || {};
          if (!d || d.from === selfId) return;      // 忽略自己发出的回声
          else if (d.t === 'state' && onStateCb) onStateCb(d.state);
          else if (d.t === 'patch' && onPatchCb) onPatchCb(d);
          else if (d.t === 'typing' && onTypingCb) onTypingCb(d);
        };
      } catch (e) { bc = null; }
    }

    /* 兜底：部分浏览器/隐私模式下 BroadcastChannel 不可用，用 storage 事件。
       ⚠ 原来判定是 `key.indexOf('wxlg_') === 0` —— 意思是**所有** wxlg_
       开头的 key 变动都被当成"状态变了"，然后 JSON.parse 塞给 onStateCb。
       而这个前缀下还有：通知设置、离线队列、登录失败计数、
       以及 IndexedDB 不可用时的媒体降级数据（wxlg_m_xxx，值是 dataURL）。

       后果：在另一个标签里改一下通知设置，这边就会把
       { enabled:true, preview:true… } 当成整份 state 去 merge。
       现在 mergeState 有 `!inS.users` 的兜底所以没炸，
       但那是**下游碰巧挡住了上游的错误** ——
       哪天有人给通知设置加个 users 字段，或者换个 merge 实现，就真串了。
       而且每次改通知、每次入队都要 JSON.parse 一遍整份状态，白费力气。

       正确做法：只认状态那一个 key。由调用方告知是哪个 key。 */
    g.addEventListener('storage', function (e) {
      if (!e.key || !onStateCb) return;
      if (stateKey ? (e.key !== stateKey)
                   : (e.key.indexOf('wxlg_') !== 0)) return;
      if (!e.newValue) return;
      try { onStateCb(JSON.parse(e.newValue)); } catch (err) { }
    });
    return bc;
  }

  /* ---------- 提交：写快照 + 广播（唯一的写入出口） ---------- */
  /* ⚠ 全量广播。当前**零处调用**（S-090 改掉了唯一那处，改用 ping）。
     保留它是因为它仍是一个有意义的通道：某些场景对方拿不到快照
     （比如没走 localStorage 的嵌入环境），只能直接收全量。

     但**不要顺手重新用起来** ——
     每次调用都是整个状态对象的结构化克隆，消息多时几十 MB，
     高频调用下广播本身会成为卡顿主因。
     需要通知别的标签时用 ping()，对方自己读快照，效果等价。 */
  function commit(state) {
    if (bc) {
      try { bc.postMessage({ t: 'state', state: state, from: selfId }); } catch (e) { }
    }
  }

  /* 轻量通知：让其他标签立即去读快照，避免大对象反复广播 */
  function ping() {
    if (bc) {
      try { bc.postMessage({ t: 'patch', from: selfId, at: Date.now() }); } catch (e) { }
    }
  }

  function close() {
    if (bc) { try { bc.close(); } catch (e) { } bc = null; }
  }

  /* ---------- 能力自检（仅用于展示，不参与业务分支） ---------- */
  function capability() {
    var cap = {
      broadcast: supported(),
      active: !!bc,
      selfId: selfId
    };
    try {
      g.localStorage.setItem('wxlg_probe', '1');
      g.localStorage.removeItem('wxlg_probe');
      cap.storage = true;
    } catch (e) { cap.storage = false; }
    cap.indexedDB = !!g.indexedDB;
    return cap;
  }

  /* 广播"正在输入"。轻量、不落盘、不做可靠性保证 ——
     丢一两条无所谓，它只是个即时状态提示。 */
  function sendTyping(who) {
    if (!bc) return false;
    try { bc.postMessage({ t: 'typing', from: selfId, nick: who && who.nick, room: who && who.room }); return true; }
    catch (e) { return false; }
  }

  g.Sync = {
    init: init,
    commit: commit,
    ping: ping,
    close: close,
    capability: capability,
    sendTyping: sendTyping
  };
})(window);
