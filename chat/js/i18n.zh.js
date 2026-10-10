/* 中文词典（默认语种，缺翻译时的回退源）
 * 只收**系统恒定文案**。聊天内容、昵称、房间名、帖子正文不在此列。 */
(function (g) {
  g.I18N_DICT = g.I18N_DICT || {};
  g.I18N_DICT.zh = {

    /* ---- 通用 ---- */
    'common.ok': '确定',
    'common.cancel': '取消',
    'common.close': '关闭',
    'common.save': '保存',
    'common.delete': '删除',
    'common.edit': '编辑',
    'common.open': '打开',
    'common.create': '创建',
    'common.remove': '移除',
    'common.copy': '复制',
    'common.send': '发送',
    'common.search': '搜索',
    'common.loading': '加载中…',
    'common.copied': '已复制',
    'common.optional': '选填',
    'common.test': '测试',
    'common.unknown': '未知',
    'common.unknownUser': '未知用户',
    'common.unknownReason': '未知原因',
    'common.networkError': '网络错误',
    'common.opFailed': '操作失败：',
    'common.people': '人',
    'common.item': '条',
    'common.count': '个',
    'common.minutes': '分钟',
    'common.supported': '支持',
    'common.unsupported': '不支持',

    /* ---- 门禁（保护密码）---- */
    'gate.title': '站点保护密码',
    'gate.placeholder': '请输入保护密码',
    'gate.enter': '进入',
    'gate.wrong': '密码错误',
    'gate.wrongOrNet': '密码错误或网络异常',
    'gate.minLen': '保护密码至少 4 位',
    'gate.updated': '保护密码已更新',
    'gate.confirmRemember': '请先确认已记住新密码',

    /* ---- 登录 / 注册 ---- */
    'login.title': '登录',
    'login.register': '注册',
    'login.nick': '昵称',
    'login.password': '登录密码',
    'login.remember': '记住账号（30 天内不用再输账号密码）',
    'login.pendingTip': '申请已提交，请等待站长通过',
    'login.nickTaken': '昵称已被占用',
    'login.pwdMinLen': '密码至少 4 位',
    'login.notFound': '找不到用户',

    /* ---- 房间 ---- */
    'room.public': '公屏大厅',
    'room.private': '私聊',
    'room.group': '群聊',
    'room.encrypted': '已加密',
    'room.online': '对方在线',
    'room.offline': '对方离线',
    'room.password': '群密码',
    'room.joinByCode': '用口令加入房间',
    'room.settings': '群设置',
    'room.invite': '邀请成员',

    /* ---- 成员管理 ---- */
    'member.mute': '禁言',
    'member.unmute': '解除禁言',
    'member.removeFromGroup': '移出本群',
    'member.ban': '封禁账号',
    'member.unban': '解封账号',
    'member.noReason': '站长未说明理由',

    /* ---- 消息 ---- */
    'msg.image': '[图片]',
    'msg.video': '[视频]',
    'msg.voice': '[语音 ',
    'msg.file': '[文件 ',
    'msg.sendFailed': '发送失败：',
    'msg.unpin': '取消置顶',

    /* ---- 设置 ---- */
    'settings.title': '设置',
    'settings.profile': '资料',
    'settings.selfCheck': '运行环境自检',

    /* ---- 通知 ---- */
    'notify.moduleMissing': '通知模块未加载',
    'notify.testBody': '这是一条测试通知',

    /* ---- 桥接（本机免密）---- */
    'bridge.detected': '检测到这台电脑上已登录 ',
    'bridge.enterAs': '直接以该身份进入',
    'bridge.note': '账号免密。站点保护密码是另一道门，仍需单独输入。',
    'bridge.entering': '正在进入…',
    'bridge.invalidTicket': '票据无效',
    'bridge.used': '这张票据已用过，请重新登录或用账号密码登录',
    'bridge.fail': '进入失败，请用账号密码登录',

    /* ---- 更新 ---- */
    'update.available': '发现新版本',
    'update.current': '当前版本',
    'update.latest': '最新版本',
    'update.download': '下载更新',
    'update.later': '稍后再说',
    'update.checking': '正在检查更新…',
    'update.upToDate': '已是最新版本',
    'update.failed': '检查更新失败',
    'update.downloading': '正在下载…',
    'update.speed': '速度',
    'update.source': '下载源',
    'update.switchSource': '换一个源',
    'update.retry': '重试',

    /* ---- 语言 ---- */
    'lang.title': '语言',
    'lang.zh': '简体中文',
    'lang.en': 'English'
  };
})(window);
