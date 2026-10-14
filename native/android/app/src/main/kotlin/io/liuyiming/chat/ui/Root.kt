package io.liuyiming.chat.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import io.liuyiming.chat.ChatApp
import kotlinx.coroutines.launch

@Composable
fun Root(app: ChatApp) {
    var loggedIn by remember { mutableStateOf(app.api.sessionToken != null) }
    if (loggedIn) Home(app) else Login(app) { loggedIn = true }
}

@Composable
fun Login(app: ChatApp, onOk: () -> Unit) {
    var nick by remember { mutableStateOf("") }
    var pwd by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(Modifier.padding(24.dp)) {
        Text("登录", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(nick, { nick = it }, label = { Text("昵称") }, singleLine = true)
        OutlinedTextField(pwd, { pwd = it }, label = { Text("密码") },
            visualTransformation = PasswordVisualTransformation(), singleLine = true)
        Spacer(Modifier.height(12.dp))

        /**
         * ⚠ 错误必须显示出来。
         * 登录失败却不给任何提示，用户只会反复重试 ——
         * 而真正的原因可能是"账号未审核""已被禁言""密码错了"，
         * 这三种的处置方式完全不同。
         */
        err?.let { Text(it, color = MaterialTheme.colorScheme.error) }

        Button(
            enabled = !busy && nick.isNotBlank() && pwd.isNotBlank(),
            onClick = {
                busy = true; err = null
                scope.launch {
                    val r = app.repo.login(nick.trim(), pwd)
                    busy = false
                    if (r.isSuccess) onOk() else err = r.exceptionOrNull()?.message ?: "登录失败"
                }
            }
        ) { Text(if (busy) "登录中…" else "登录") }
    }
}

@Composable
fun Home(app: ChatApp) {
    var rooms by remember { mutableStateOf(listOf<io.liuyiming.chat.data.db.RoomEntity>()) }
    LaunchedEffect(Unit) { rooms = app.repo.rooms() }
    Column(Modifier.padding(16.dp)) {
        Text("会话", style = MaterialTheme.typography.headlineMedium)
        rooms.forEach { r -> Text(r.name, Modifier.padding(vertical = 8.dp)) }
    }
}
