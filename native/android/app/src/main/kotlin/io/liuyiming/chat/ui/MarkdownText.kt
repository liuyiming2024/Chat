package io.liuyiming.chat.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.graphics.toArgb
import androidx.compose.material3.MaterialTheme
import io.liuyiming.chat.core.Markdown

/**
 * 在 Compose 里渲染 Markdown。
 *
 * ⚠ 必须把 Compose 的主题色传给 TextView。（NATIVE-MD）
 * 不传的话深色模式下文字是黑的、背景也是黑的 ——
 * 消息变成一片看不见，而用户只会以为"消息没加载出来"。
 */
@Composable
fun MarkdownText(text: String, modifier: Modifier = Modifier) {
    val color = MaterialTheme.colorScheme.onSurface
    if (!Markdown.looksLikeMarkdown(text)) {
        androidx.compose.material3.Text(text, modifier = modifier, color = color)
        return
    }
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            android.widget.TextView(ctx).apply {
                setTextColor(color.toArgb())
                textSize = 15f
                setLineSpacing(0f, 1.15f)
            }
        },
        update = { tv ->
            tv.setTextColor(color.toArgb())
            tv.text = Markdown.render(tv.context, text)
        }
    )
}
