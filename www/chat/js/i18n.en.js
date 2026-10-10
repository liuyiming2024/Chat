/* English dictionary.
 * Only **system-level strings**. Chat messages, nicknames, room names,
 * and post bodies are user data and are never translated. */
(function (g) {
  g.I18N_DICT = g.I18N_DICT || {};
  g.I18N_DICT.en = {

    /* ---- common ---- */
    'common.ok': 'OK',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.open': 'Open',
    'common.create': 'Create',
    'common.remove': 'Remove',
    'common.copy': 'Copy',
    'common.send': 'Send',
    'common.search': 'Search',
    'common.loading': 'Loading…',
    'common.copied': 'Copied',
    'common.optional': 'Optional',
    'common.test': 'Test',
    'common.unknown': 'Unknown',
    'common.unknownUser': 'Unknown user',
    'common.unknownReason': 'Unknown reason',
    'common.networkError': 'Network error',
    'common.opFailed': 'Operation failed: ',
    'common.people': '',
    'common.item': '',
    'common.count': '',
    'common.minutes': ' min',
    'common.supported': 'Supported',
    'common.unsupported': 'Not supported',

    /* ---- gate (site password) ---- */
    'gate.title': 'Site password',
    'gate.placeholder': 'Enter site password',
    'gate.enter': 'Enter',
    'gate.wrong': 'Wrong password',
    'gate.wrongOrNet': 'Wrong password or network error',
    'gate.minLen': 'Site password must be at least 4 characters',
    'gate.updated': 'Site password updated',
    'gate.confirmRemember': 'Please confirm you have saved the new password',

    /* ---- login / register ---- */
    'login.title': 'Sign in',
    'login.register': 'Register',
    'login.nick': 'Nickname',
    'login.password': 'Password',
    'login.remember': 'Remember me (no need to sign in again for 30 days)',
    'login.pendingTip': 'Request submitted, waiting for the owner to approve',
    'login.nickTaken': 'Nickname already taken',
    'login.pwdMinLen': 'Password must be at least 4 characters',
    'login.notFound': 'User not found',

    /* ---- room ---- */
    'room.public': 'Public hall',
    'room.private': 'Direct message',
    'room.group': 'Group',
    'room.encrypted': 'Encrypted',
    'room.online': 'Online',
    'room.offline': 'Offline',
    'room.password': 'Group password',
    'room.joinByCode': 'Join room with a code',
    'room.settings': 'Group settings',
    'room.invite': 'Invite members',

    /* ---- member management ---- */
    'member.mute': 'Mute',
    'member.unmute': 'Unmute',
    'member.removeFromGroup': 'Remove from group',
    'member.ban': 'Ban account',
    'member.unban': 'Unban account',
    'member.noReason': 'No reason given by the owner',

    /* ---- message ---- */
    'msg.image': '[Image]',
    'msg.video': '[Video]',
    'msg.voice': '[Voice ',
    'msg.file': '[File ',
    'msg.sendFailed': 'Failed to send: ',
    'msg.unpin': 'Unpin',

    /* ---- settings ---- */
    'settings.title': 'Settings',
    'settings.profile': 'Profile',
    'settings.selfCheck': 'Environment check',

    /* ---- notification ---- */
    'notify.moduleMissing': 'Notification module not loaded',
    'notify.testBody': 'This is a test notification',

    /* ---- local bridge ---- */
    'bridge.detected': 'Signed in on this computer as ',
    'bridge.enterAs': 'Continue as this user',
    'bridge.note': 'Account sign-in is skipped. The site password is a separate gate and is still required.',
    'bridge.entering': 'Signing in…',
    'bridge.invalidTicket': 'Invalid ticket',
    'bridge.used': 'This ticket was already used. Please sign in again or use your password',
    'bridge.fail': 'Could not sign in, please use your password',

    /* ---- update ---- */
    'update.available': 'New version available',
    'update.current': 'Current version',
    'update.latest': 'Latest version',
    'update.download': 'Download update',
    'update.later': 'Later',
    'update.checking': 'Checking for updates…',
    'update.upToDate': 'Already up to date',
    'update.failed': 'Update check failed',
    'update.downloading': 'Downloading…',
    'update.speed': 'Speed',
    'update.source': 'Source',
    'update.switchSource': 'Switch source',
    'update.retry': 'Retry',

    /* ---- language ---- */
    'lang.title': 'Language',
    'lang.zh': '简体中文',
    'lang.en': 'English'
  };
})(window);
