/* ------------------------------------------------------------------
 * i18n.js —— 界面文案多语言（简体中文 / English）
 *
 * 范围边界（重要）：
 *   只翻译【系统恒定文案】—— 导航、按钮、标签、提示、设置项、菜单。
 *   不翻译【用户产生的内容】—— 聊天消息、昵称、群名、帖子。
 *   用户发的是什么语言，就显示什么语言，不做任何转换。
 *
 * 用法：
 *   1) 静态文案：给元素加 data-i18n="key"，applyI18n() 自动填
 *      另有 data-i18n-attr="placeholder" 可写进属性而非文本
 *   2) 动态文案：t('key') 直接取
 *   3) 带变量：t('key', {n: 5})  → 文案里写 {n}
 *
 * 语言选择：显式选择 > 上次选择 > 浏览器语言 > 简体中文
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var STORE_KEY = 'wxlg_lang';
  var DEFAULT = 'zh-CN';
  var SUPPORTED = ['zh-CN', 'en'];

  var DICT = {
    'zh-CN': {
      /* ---- 通用 ---- */
      'cancel': '取消',
      'ok': '确定',
      'confirm': '确认',
      'close': '关闭',
      'save': '保存',
      'delete': '删除',
      'edit': '编辑',
      'send': '发送',
      'search': '搜索',
      'loading': '加载中…',
      'retry': '重试',
      'copied': '已复制',
      'unknown': '未知',

      /* ---- 导航 ---- */
      'nav.home': '首页',
      'nav.chat': '聊天室',
      'nav.forum': '贴吧',
      'nav.docs': '使用手册',
      'nav.backHome': '返回首页',

      /* ---- 门禁 / 登录 ---- */
      'gate.title': '进入',
      'gate.sub': '请输入站点保护密码',
      'gate.placeholder': '站点保护密码',
      'gate.remember': '本次会话内不再询问',
      'gate.enter': '进入',
      'gate.wrong': '保护密码错误',
      'gate.notInit': '站点尚未初始化',

      'login.title': '登录',
      'login.tab': '登录',
      'reg.tab': '注册',
      'login.nick': '昵称',
      'login.password': '登录密码',
      'login.remember': '记住账号（30 天内不用再输账号密码）',
      'login.submit': '登录',
      'reg.submit': '注册',
      'login.pending': '账号待审核，还不能发言',
      'login.banned': '账号已被停用',
      'login.frozen': '尝试次数过多，请 {n} 分钟后再试',

      /* ---- 本机桥接 ---- */
      'bridge.detected': '检测到这台电脑上已登录 {nick}',
      'bridge.enter': '直接以该身份进入',
      'bridge.note': '账号免密。站点保护密码是另一道门，仍需单独输入。',
      'bridge.used': '本机票据已用过（每张只能用一次）。请在客户端里重新登录一次，或直接用账号密码登录。',
      'bridge.unavailable': '本机桥接端口被占用，已停用',

      /* ---- 通知 / 免打扰 ---- */
      'notify.title': '消息通知',
      'notify.enable': '开启通知',
      'notify.preview': '显示消息内容',
      'notify.sound': '提示音',
      'notify.dnd': '免打扰',
      'notify.dndGlobal': '全局免打扰',
      'notify.dndSchedule': '按时间段免打扰',
      'notify.dndFrom': '开始',
      'notify.dndTo': '结束',
      'notify.mutedRooms': '已静音的会话',
      'notify.test': '发一条测试通知',
      'notify.testSent': '测试通知已发送',
      'notify.newMessage': '新消息',
      'notify.unread': '{n} 条未读',

      /* ---- 设置 ---- */
      'settings.title': '设置',
      'settings.theme': '主题',
      'settings.themeSimple': '极简',
      'settings.themePro': '专业',
      'settings.dark': '深色模式',
      'settings.language': '语言',
      'settings.about': '关于',

      /* ---- 客户端下载 ---- */
      'client.title': '装到设备上',
      'client.win': 'Windows',
      'client.mac': 'macOS',
      'client.linux': 'Linux',
      'client.android': '安卓',
      'client.ios': 'iPhone / iPad',
      'client.web': '不想装？用网页版',
      'client.download': '下载',
      'client.unsigned': '所有安装包都未签名 —— 代码签名证书需要年费。首次安装需手动确认。',

      /* ---- 更新 ---- */
      'update.found': '发现新版本 {v}',
      'update.current': '当前 {v}，已是最新',
      'update.check': '检查更新',
      'update.download': '下载更新',
      'update.checking': '正在检查更新…',
      'update.fail': '检查更新失败',
      'update.mirror': '下载源',
      'update.speed': '测速中…'
    },

    'en': {
      /* ---- Common ---- */
      'cancel': 'Cancel',
      'ok': 'OK',
      'confirm': 'Confirm',
      'close': 'Close',
      'save': 'Save',
      'delete': 'Delete',
      'edit': 'Edit',
      'send': 'Send',
      'search': 'Search',
      'loading': 'Loading…',
      'retry': 'Retry',
      'copied': 'Copied',
      'unknown': 'Unknown',

      /* ---- Nav ---- */
      'nav.home': 'Home',
      'nav.chat': 'Chat',
      'nav.forum': 'Forum',
      'nav.docs': 'Manual',
      'nav.backHome': 'Back to home',

      /* ---- Gate / Login ---- */
      'gate.title': 'Enter',
      'gate.sub': 'Enter the site access password',
      'gate.placeholder': 'Site access password',
      'gate.remember': 'Do not ask again this session',
      'gate.enter': 'Enter',
      'gate.wrong': 'Wrong access password',
      'gate.notInit': 'Site is not initialized',

      'login.title': 'Sign in',
      'login.tab': 'Sign in',
      'reg.tab': 'Sign up',
      'login.nick': 'Nickname',
      'login.password': 'Password',
      'login.remember': 'Remember me (no password needed for 30 days)',
      'login.submit': 'Sign in',
      'reg.submit': 'Sign up',
      'login.pending': 'Account pending approval — cannot post yet',
      'login.banned': 'Account disabled',
      'login.frozen': 'Too many attempts, try again in {n} minutes',

      /* ---- Local bridge ---- */
      'bridge.detected': '{nick} is signed in on this computer',
      'bridge.enter': 'Continue as this user',
      'bridge.note': 'Password-free sign-in. The site access password is a separate step.',
      'bridge.used': 'This one-time ticket was already used. Sign in again in the app, or use your password.',
      'bridge.unavailable': 'Local bridge port is occupied — disabled',

      /* ---- Notifications ---- */
      'notify.title': 'Notifications',
      'notify.enable': 'Enable notifications',
      'notify.preview': 'Show message content',
      'notify.sound': 'Sound',
      'notify.dnd': 'Do not disturb',
      'notify.dndGlobal': 'Do not disturb (all)',
      'notify.dndSchedule': 'Scheduled quiet hours',
      'notify.dndFrom': 'From',
      'notify.dndTo': 'To',
      'notify.mutedRooms': 'Muted conversations',
      'notify.test': 'Send a test notification',
      'notify.testSent': 'Test notification sent',
      'notify.newMessage': 'New message',
      'notify.unread': '{n} unread',

      /* ---- Settings ---- */
      'settings.title': 'Settings',
      'settings.theme': 'Theme',
      'settings.themeSimple': 'Simple',
      'settings.themePro': 'Professional',
      'settings.dark': 'Dark mode',
      'settings.language': 'Language',
      'settings.about': 'About',

      /* ---- Desktop clients ---- */
      'client.title': 'Install on your device',
      'client.win': 'Windows',
      'client.mac': 'macOS',
      'client.linux': 'Linux',
      'client.android': 'Android',
      'client.ios': 'iPhone / iPad',
      'client.web': 'Rather not install? Use the web version',
      'client.download': 'Download',
      'client.unsigned': 'All installers are unsigned — code-signing certificates cost money. Confirm manually on first install.',

      /* ---- Update ---- */
      'update.found': 'Version {v} available',
      'update.current': 'You are on {v}, up to date',
      'update.check': 'Check for updates',
      'update.download': 'Download update',
      'update.checking': 'Checking for updates…',
      'update.fail': 'Update check failed',
      'update.mirror': 'Download source',
      'update.speed': 'Testing speed…'
    }
  };

  var cur = DEFAULT;

  function detect() {
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) { }
    if (saved && SUPPORTED.indexOf(saved) >= 0) return saved;

    var nav = (navigator.language || '').toLowerCase();
    if (nav.indexOf('zh') === 0) return 'zh-CN';
    if (nav.indexOf('en') === 0) return 'en';
    return DEFAULT;
  }

  function set(lang) {
    if (SUPPORTED.indexOf(lang) < 0) lang = DEFAULT;
    cur = lang;
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) { }
    try { document.documentElement.lang = lang; } catch (e) { }
    apply();
  }

  function get() { return cur; }

  /* 取文案。vars 里的 {key} 会被替换。取不到就返回 key 本身 ——
     宁可页面上显示一个英文 key，也不要 undefined 造成空白。 */
  function t(key, vars) {
    var d = DICT[cur] || DICT[DEFAULT];
    var s = d[key];
    if (s == null) s = (DICT[DEFAULT][key] != null ? DICT[DEFAULT][key] : key);
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.split('{' + k + '}').join(String(vars[k]));
      });
    }
    return s;
  }

  /* 把页面上所有带 data-i18n 的元素填一遍。
     幂等 —— 切换语言时反复调用即可，不会叠加。 */
  function apply(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-i18n]');
    Array.prototype.forEach.call(nodes, function (el) {
      var key = el.getAttribute('data-i18n');
      var attr = el.getAttribute('data-i18n-attr');
      var val = t(key);
      if (attr) el.setAttribute(attr, val);
      else el.textContent = val;
    });
    try { document.documentElement.lang = cur; } catch (e) { }
  }

  function list() {
    return SUPPORTED.map(function (c) {
      return { code: c, name: c === 'zh-CN' ? '简体中文' : 'English' };
    });
  }

  cur = detect();

  g.I18n = {
    t: t, set: set, get: get, apply: apply, list: list,
    SUPPORTED: SUPPORTED
  };
})(window);
