package io.liuyiming.chat.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import io.liuyiming.chat.core.I18n
import io.liuyiming.chat.core.MediaStore
import io.liuyiming.chat.core.Settings
import io.liuyiming.chat.core.Strings

@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val ctx = LocalContext.current
    // 切换语言后必须**重绘**。不重绘的话文案不变，用户以为点了没用（Chat 端踩过）
    var lang by remember { mutableStateOf(I18n.current) }
    var mediaBytes by remember { mutableStateOf(MediaStore.size(ctx)) }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text(Strings.t("settings"), style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(16.dp))

        Text(Strings.t("language"), style = MaterialTheme.typography.titleSmall) // NATIVE-I18N
        I18n.SUPPORTED.forEach { code ->
            Row(Modifier.fillMaxWidth().clickable {
                Settings.saveLang(ctx, code)
                lang = code
            }.padding(vertical = 10.dp)) {
                RadioButton(selected = lang == code, onClick = {
                    Settings.saveLang(ctx, code); lang = code
                })
                Spacer(Modifier.width(8.dp))
                Text(if (code == I18n.ZH) "简体中文" else "English")
            }
        }

        HorizontalDivider(Modifier.padding(vertical = 12.dp))
        /**
         * 媒体占用必须显示出来。
         * 不显示的话，用户发现存储空间没了也不知道是谁占的 ——
         * 而这里的缓存是按内容哈希存的，本就不会重复占，
         * 说清楚反而能让人放心。
         */
        Text("媒体缓存：${"%.1f".format(mediaBytes / 1024f / 1024f)} MB")
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = { mediaBytes = MediaStore.size(ctx) }) { Text("刷新") }

        Spacer(Modifier.weight(1f))
        TextButton(onClick = onBack) { Text("返回") }
    }
}
