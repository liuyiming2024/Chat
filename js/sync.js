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

    if (supported()) {
      try {
        bc = new BroadcastChannel(CHANNEL);
        bc.onmessage = function (e) {
          var d = e.data || {};
          if (!d || d.from === selfId) return;      // 忽略自己发出的回声
          if (d.t === 'state' && onStateCb) onStateCb(d.state);
          else if (d.t === 'patch' && onPatchCb) onPatchCb(d);
        };
      } catch (e) { bc = null; }
    }

    /* 兜底：部分浏览器/隐私模式下 BroadcastChannel 不可用，用 storage 事件 */
    g.addEventListener('storage', function (e) {
      if (!e.key || e.key.indexOf('wxlg_') !== 0) return;
      if (!e.newValue || !onStateCb) return;
      try { onStateCb(JSON.parse(e.newValue)); } catch (err) { }
    });
    return bc;
  }

  /* ---------- 提交：写快照 + 广播（唯一的写入出口） ---------- */
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

  g.Sync = {
    init: init,
    commit: commit,
    ping: ping,
    close: close,
    capability: capability
  };
})(window);
