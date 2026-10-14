package io.liuyiming.chat.core

import android.content.Context
import android.text.Spanned
import android.widget.TextView
import io.noties.markwon.Markwon

/**
 * Markdown 渲染。Web 版对应 chat/js/markdown.js。
 *
 * ⚠ 为什么必须要有（NATIVE-MD）：没有等价物的话，**粗体**、`代码` 会原样露出来，
 * 用户看到的是一堆星号 —— 那是明显的功能倒退，比不支持更糟。
 *
 * ⚠ 用 AndroidView 包 TextView 而不是自己做解析：
 * Markwon 处理的是 Spanned，Compose 的 Text 不支持。
 * 自己写解析是重复造轮子，而且转义规则极容易写错
 * （Web 版出过"链接文本没转义"这类缺陷）。
 */
object Markdown {
    @Volatile
    private var markwon: Markwon? = null

    private fun engine(ctx: Context): Markwon {
        return markwon ?: synchronized(this) {
            markwon ?: Markwon.create(ctx.applicationContext).also { markwon = it }
        }
    }

    fun render(ctx: Context, src: CharSequence): Spanned =
        engine(ctx).toMarkdown(src.toString())

    /**
     * 内容是否含 Markdown 语法。
     * 纯文本没必要走渲染 —— 每条消息都建 Spanned 会拖慢长列表。
     */
    fun looksLikeMarkdown(s: String): Boolean =
        s.contains("**") || s.contains('`') || s.contains("# ") || s.contains("](")
}
