package io.liuyiming.chat.core

import android.content.Context

/**
 * 轻量设置项。用 SharedPreferences 而不是 Room ——
 * 设置是键值对，为它建表是把简单事做复杂。
 * 业务数据才用 Room，这条界线要清楚。
 */
object Settings {
    private const val P = "chat_settings"
    private const val K_LANG = "lang"

    fun loadLang(ctx: Context) {
        val v = ctx.getSharedPreferences(P, Context.MODE_PRIVATE).getString(K_LANG, null)
        I18n.set(v ?: I18n.detect())
    }

    fun saveLang(ctx: Context, code: String) {
        I18n.set(code)
        ctx.getSharedPreferences(P, Context.MODE_PRIVATE).edit().putString(K_LANG, code).apply()
    }
}
