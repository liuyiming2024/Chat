/* ------------------------------------------------------------------
 * acl.js —— 权限模型（细粒度 · 逐项可分化的最终版）
 *
 * 设计原则：
 *   1. 站长（owner）恒为全部权限，不可被剥夺、不参与勾选。
 *   2. "管理员"只是一个**称号**，本身不再携带固定权限；
 *      每个管理员实际能做什么，完全由逐项勾选的权限决定。
 *      这就是"同样是管理员，各人手里的权不一样"。
 *   3. 每个权限项对每个人有三种状态：
 *        继承(inherit) 按角色默认走
 *        允许(allow)   显式授予，覆盖角色默认
 *        禁止(deny)    显式收回，优先级最高（站长除外）
 *   4. 判定顺序：封禁 → 站长 → 显式禁止 → 显式允许 → 角色默认 → 房间角色。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  /* ---------------- 权限总表（分组） ---------------- */
  var GROUPS = [
    {
      key: 'msg', name: '消息', perms: [
        ['msg.send', '发言'],
        ['msg.recall.own', '撤回自己的消息'],
        ['msg.edit', '编辑自己的消息'],
        ['msg.remove', '移除他人消息（前台隐藏，后台留痕）'],
        ['msg.delete', 'Delete 物理删除并释放空间'],
        ['msg.viewRaw', '查看被撤回 / 移除消息的原文'],
        ['msg.pin', '置顶消息']
      ]
    },
    {
      key: 'media', name: '媒体', perms: [
        ['media.image', '发送图片'],
        ['media.video', '发送视频'],
        ['media.voice', '发送语音'],
        ['media.file', '发送文件附件']
      ]
    },
    {
      key: 'room', name: '房间', perms: [
        ['room.create', '创建群聊'],
        ['room.rename', '修改群名'],
        ['room.notice', '修改群公告'],
        ['room.desc', '修改群简介'],
        ['room.pwd', '修改群密码'],
        ['room.invite', '邀请成员 / 生成邀请口令'],
        ['room.kick', '移出群成员'],
        ['room.grant', '设置 / 撤销群管理员'],
        ['room.delete', '解散群聊'],
        ['room.export', '导出群聊记录']
      ]
    },
    {
      key: 'user', name: '用户管理', perms: [
        ['user.view', '查看成员列表与资料'],
        ['user.mute', '禁言 / 解除禁言'],
        ['user.ban', '封禁 / 解封账号'],
        ['user.create', '手动开户'],
        ['user.delete', '删除用户'],
        ['user.grant', '授予 / 回收管理员称号'],
        ['user.perms', '分配他人的权限'],
        ['user.transfer', '转让站长']
      ]
    },
    {
      key: 'audit', name: '审核与日志', perms: [
        ['audit.review', '审核注册申请'],
        ['audit.log', '查看操作日志']
      ]
    },
    {
      key: 'site', name: '站点', perms: [
        ['site.name', '修改站点名称'],
        ['site.gate', '修改保护密码'],
        ['site.register', '开关注册与审核'],
        ['site.clean', '清理旧媒体'],
        ['site.export', '导出全站数据'],
        ['site.reset', '重置站点']
      ]
    },
    {
      key: 'sys', name: '系统', perms: [
        ['sys.notice', '发布全站公告'],
        ['sys.env', '查看运行环境']
      ]
    }
  ];

  /* 扁平索引：perm -> 中文名 */
  var PERMS = {};
  GROUPS.forEach(function (grp) {
    grp.perms.forEach(function (p) { PERMS[p[0]] = p[1]; });
  });

  /* 角色默认权限（inherit 时按此判定）。
     注意：admin 的这套只是"新建管理员时的初始模板"，
     之后可在权限矩阵里逐项增减，不再是铁板一块。 */
  var ROLE_PERMS = {
    owner: Object.keys(PERMS),
    admin: [
      'msg.send', 'msg.recall.own', 'msg.edit', 'msg.remove', 'msg.viewRaw',
      'media.image', 'media.video', 'media.voice', 'media.file',
      'room.create', 'room.rename', 'room.notice', 'room.desc', 'room.pwd',
      'room.invite', 'room.kick', 'room.delete', 'room.export',
      'user.view', 'user.mute', 'user.kick2', 'user.ban', 'user.create',
      'audit.review', 'audit.log',
      'site.name', 'site.register', 'site.clean', 'site.export',
      'sys.notice', 'sys.env'
    ],
    member: [
      'msg.send', 'msg.recall.own', 'msg.edit',
      'media.image', 'media.video', 'media.voice', 'media.file',
      'room.create', 'user.view', 'sys.env'
    ]
  };
  /* 清理：admin 模板里误写的 user.kick2 */
  ROLE_PERMS.admin = ROLE_PERMS.admin.filter(function (p) { return PERMS[p]; });

  /* ---------------- 判定 ---------------- */

  function roomRole(user, room) {
    if (!user) return 'guest';
    if (user.role === 'owner') return 'owner';
    if (room && room.owner === user.id) return 'roomOwner';
    if (room && room.admins && room.admins.indexOf(user.id) >= 0) return 'roomAdmin';
    return 'member';
  }

  /* 房间内的固有权力：群主 / 群管理员在自己的群里天然能做的事 */
  var ROOM_INHERENT = [
    'room.rename', 'room.notice', 'room.desc', 'room.pwd',
    'room.invite', 'room.kick', 'room.delete', 'room.export',
    'user.mute'
  ];

  /* 聚合权限：一个键代表"拥有其中任一子权限即可"。
     这样旧代码里的 media.send / room.manage / msg.recall 仍能正常工作，
     同时不影响细粒度拆分。 */
  var AGGREGATE = {
    'msg.recall': ['msg.recall.own'],
    'media.send': ['media.image', 'media.video', 'media.voice', 'media.file'],
    'room.manage': ['room.rename', 'room.notice', 'room.desc', 'room.pwd', 'room.invite', 'room.kick']
  };

  function can(user, perm, room) {
    if (!user) return false;
    if (user.banned && perm !== 'msg.send') return false;

    /* 聚合键展开：任一子权限通过即可 */
    if (AGGREGATE[perm]) {
      return AGGREGATE[perm].some(function (p) { return can(user, p, room); });
    }

    /* 1) 站长恒为全部权限，不可剥夺 */
    if (user.role === 'owner') return true;

    /* 2) 显式禁止（优先级高于角色默认与房间角色） */
    var denied = user.denied || [];
    if (denied.indexOf(perm) >= 0) return false;

    /* 3) 显式授予 */
    var extra = user.perms || [];
    if (extra.indexOf(perm) >= 0) return true;

    /* 4) 角色默认 */
    if (ROLE_PERMS[user.role] && ROLE_PERMS[user.role].indexOf(perm) >= 0) return true;

    /* 5) 群主 / 群管理员在自己房间内的固有权力 */
    var rr = roomRole(user, room);
    if ((rr === 'roomOwner' || rr === 'roomAdmin') && ROOM_INHERENT.indexOf(perm) >= 0) return true;

    return false;
  }

  /* 三项状态：inherit / allow / deny（站长恒为 allow 且不可改） */
  function stateOf(user, perm) {
    if (!user) return 'inherit';
    if ((user.denied || []).indexOf(perm) >= 0) return 'deny';
    if ((user.perms || []).indexOf(perm) >= 0) return 'allow';
    return 'inherit';
  }

  function setState(user, perm, st) {
    if (!user) return;
    user.perms = (user.perms || []).filter(function (x) { return x !== perm; });
    user.denied = (user.denied || []).filter(function (x) { return x !== perm; });
    if (st === 'allow') user.perms.push(perm);
    else if (st === 'deny') user.denied.push(perm);
  }

  /* 该权限最终是否生效（含角色默认），用于展示 */
  function effective(user, perm, room) { return can(user, perm, room); }

  /* ---------------- 禁言 ---------------- */
  function muted(user) {
    return !!(user && user.mutedUntil && user.mutedUntil > Date.now());
  }
  function muteLeft(user) {
    if (!muted(user)) return 0;
    return Math.ceil((user.mutedUntil - Date.now()) / 1000);
  }
  function canSpeak(user, room) {
    if (!can(user, 'msg.send', room)) return { ok: false, why: '没有发言权限' };
    if (muted(user)) return { ok: false, why: '你已被禁言，剩余 ' + muteLeft(user) + ' 秒' };
    if (room && room.muted && room.muted.indexOf(user.id) >= 0) return { ok: false, why: '你已被本群禁言' };
    return { ok: true };
  }

  /* ---------------- 展示辅助 ---------------- */
  function label(perm) { return PERMS[perm] || perm; }
  function all() { return Object.keys(PERMS); }
  function groups() { return GROUPS; }

  function roleName(u) {
    if (!u) return '访客';
    if (u.role === 'owner') return '站长';
    if (u.role === 'admin') return '管理员';
    return '成员';
  }

  /* 统计某人实际被显式改动了多少项（界面上提示"自定义过 N 项"） */
  function customCount(u) {
    if (!u) return 0;
    return (u.perms || []).length + (u.denied || []).length;
  }

  /* ---------------- 服务端权威判定 ----------------
   * 在线模式下，真正的权限由服务端 acl_can() 说了算，
   * 前端这份只用于「要不要显示按钮」—— 显示不等于放行。
   * 每次拿到服务端的 acl_mine() 结果后调用 syncFromServer() 覆盖本地判定，
   * 避免前端按过期角色渲染出不该出现的按钮。 */
  var SERVER = null;

  function syncFromServer(j) {
    if (!j || !j.perms) return;
    SERVER = j.perms;
    /* 角色与昵称也以服务端为准，防止本地被篡改后界面显示错身份 */
    if (window.APP && window.APP.state && window.APP.state()) {
      var me = window.APP.state().me;
      if (me) { if (j.role) me.role = j.role; if (j.nick) me.nick = j.nick; }
    }
  }
  function fromServer() { return SERVER; }
  function isSynced() { return !!SERVER; }

  /* 服务端已同步时以其为准，否则退回本地判定（离线模式） */
  function canEffective(user, perm, room) {
    if (SERVER && Object.prototype.hasOwnProperty.call(SERVER, perm)) {
      return SERVER[perm] === true;
    }
    return can(user, perm, room);
  }

  g.ACL = {
    PERMS: PERMS, GROUPS: GROUPS, ROLE_PERMS: ROLE_PERMS,
    can: canEffective, canLocal: can,
    canSpeak: canSpeak, roomRole: roomRole,
    muted: muted, muteLeft: muteLeft,
    label: label, all: all, groups: groups, roleName: roleName,
    stateOf: stateOf, setState: setState, effective: effective,
    customCount: customCount,
    syncFromServer: syncFromServer, fromServer: fromServer, isSynced: isSynced
  };
})(window);
