/* ------------------------------------------------------------------
 * acl.js —— 权限模型
 *  三级角色：站长 owner > 管理员 admin > 普通成员 member
 *  站长可授予 / 回收管理员，可转让站长；管理员可在被授权的房间内行使管理权
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var PERMS = {
    'msg.send': '发言',
    'msg.delete': '删除他人消息',
    'msg.recall': '撤回自己的消息',
    'media.send': '发送图片 / 视频',
    'room.create': '创建群聊',
    'room.manage': '管理群成员',
    'room.notice': '修改群公告',
    'room.pwd': '修改群密码',
    'room.delete': '解散群聊',
    'user.mute': '禁言成员',
    'user.kick': '移出群聊',
    'user.ban': '封禁账号',
    'user.grant': '授予 / 回收管理员',
    'user.transfer': '转让站长',
    'gate.set': '修改进入密码',
    'log.view': '查看管理日志'
  };

  var ROLE_PERMS = {
    owner: Object.keys(PERMS),
    admin: ['msg.send', 'msg.delete', 'msg.recall', 'media.send', 'room.create',
      'room.manage', 'room.notice', 'room.pwd', 'user.mute', 'user.kick', 'user.ban', 'log.view'],
    member: ['msg.send', 'msg.recall', 'media.send', 'room.create']
  };

  /* 房间内角色：站长 / 群主 / 群管理员 / 成员 */
  function roomRole(user, room) {
    if (!user) return 'guest';
    if (user.role === 'owner') return 'owner';
    if (room && room.owner === user.id) return 'roomOwner';
    if (room && room.admins && room.admins.indexOf(user.id) >= 0) return 'roomAdmin';
    return 'member';
  }

  function can(user, perm, room) {
    if (!user) return false;
    if (user.banned && perm !== 'msg.send') return false;
    if (user.role === 'owner') return true;

    var extra = user.perms || [];
    if (extra.indexOf(perm) >= 0) return true;

    if (user.role === 'admin' && ROLE_PERMS.admin.indexOf(perm) >= 0) return true;

    var rr = roomRole(user, room);
    if (rr === 'roomOwner' || rr === 'roomAdmin') {
      if (['room.manage', 'room.notice', 'room.pwd', 'user.mute', 'user.kick', 'msg.delete', 'room.delete'].indexOf(perm) >= 0) return true;
    }
    if (ROLE_PERMS.member.indexOf(perm) >= 0 && rr !== 'guest') return true;
    return false;
  }

  /* 是否处于禁言中 */
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

  function label(perm) { return PERMS[perm] || perm; }
  function all() { return Object.keys(PERMS); }

  function roleName(u) {
    if (!u) return '访客';
    if (u.role === 'owner') return '站长';
    if (u.role === 'admin') return '管理员';
    return '成员';
  }

  g.ACL = {
    PERMS: PERMS, ROLE_PERMS: ROLE_PERMS,
    can: can, canSpeak: canSpeak, roomRole: roomRole,
    muted: muted, muteLeft: muteLeft,
    label: label, all: all, roleName: roleName
  };
})(window);
