package io.liuyiming.chat.core

import java.util.Locale

/**
 * 多语言。语言标签必须与 Web 版 **完全一致**（`zh-CN` / `en`）。
 *
 * ⚠ Chat 端踩过的坑（原样避开）：
 *   1. 设置面板调了一个**不存在的函数** `cur()` —— 抛错中断渲染，
 *      于是语言那一行之后的设置项**全部消失**。用户看到的是面板残缺，
 *      根本想不到根因在多语言。
 *   2. 值写成 `'zh'`，而支持列表里是 `'zh-CN'` → 判定不支持，静默回退默认。
 *   3. 切换后**不重绘** → 文案不变，用户以为点了没用。
 *
 * 所以这里：语言标签用常量、缺失 key 走兜底而不是返回 key 本身 ——
 * 返回 key 的话，用户会看到 `common.close` 这种英文串，（NATIVE-I18N）
 * 缺 key 比不翻译更糟：不翻译至少看得懂，露出 key 是明显错误。
 */
object I18n {
    const val ZH = "zh-CN"
    const val EN = "en"
    val SUPPORTED = listOf(ZH, EN)
    const val DEFAULT = ZH

    @Volatile
    var current: String = DEFAULT
        private set

    fun set(code: String) {
        current = if (code in SUPPORTED) code else DEFAULT
    }

    fun detect(): String {
        val l = Locale.getDefault().toLanguageTag()
        return SUPPORTED.firstOrNull { l.startsWith(it) } ?: DEFAULT
    }
}

/**
 * 词条。缺 key 时返回中文兜底，绝不返回 key 本身。
 */
object Strings {
    private val zh = mapOf(
        "app_name" to "聊天室",
        "login" to "登录",
        "nickname" to "昵称",
        "password" to "密码",
        "login_failed" to "登录失败",
        "rooms" to "会话",
        "no_rooms" to "还没有会话",
        "send" to "发送",
        "say_something" to "说点什么",
        "revoke" to "撤回",
        "revoke_expired" to "撤回（已超时）",
        "edited" to "已编辑",
        "queued" to "暂时发不出去，已存入待发队列，联网后自动补发",
        "over_limit" to "消息超过 8000 字，请分段发送",
        "settings" to "设置",
        "language" to "语言",
        "about" to "关于"
    )
    private val en = mapOf(
        "app_name" to "Chat",
        "login" to "Sign in",
        "nickname" to "Nickname",
        "password" to "Password",
        "login_failed" to "Sign-in failed",
        "rooms" to "Rooms",
        "no_rooms" to "No conversations yet",
        "send" to "Send",
        "say_something" to "Say something",
        "revoke" to "Revoke",
        "revoke_expired" to "Revoke (expired)",
        "edited" to "edited",
        "queued" to "Can't send right now — queued, will retry when online",
        "over_limit" to "Message exceeds 8000 characters",
        "settings" to "Settings",
        "language" to "Language",
        "about" to "About"
    )

    /**
     * 取词条。**缺 key 返回中文兜底**，不返回 key 本身。
     * 另外这里刻意让两个词典的 key 集合保持一致 —— Chat 端出过
     * "代码里用了 key 但词典里没有" 的缺陷，界面直接露出英文 key。
     * init 里做一次双向校验，开发期就能发现。
     */
    fun t(key: String): String {
        val table = if (I18n.current == I18n.EN) en else zh
        return table[key] ?: zh[key] ?: ""
    }

    init {
        val onlyZh = zh.keys - en.keys
        val onlyEn = en.keys - zh.keys
        require(onlyZh.isEmpty() && onlyEn.isEmpty()) {
            "中英词典 key 不一致：仅中文有 $onlyZh，仅英文有 $onlyEn"
        }
    }
}
