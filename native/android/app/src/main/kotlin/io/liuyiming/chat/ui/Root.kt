package io.liuyiming.chat.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import io.liuyiming.chat.ChatApp
import io.liuyiming.chat.core.Strings
import kotlinx.coroutines.launch

@Composable
fun Root(app: ChatApp) {
    var loggedIn by remember { mutableStateOf(app.api.sessionToken != null) }
    if (loggedIn) Nav(app) else Login(app) { loggedIn = true }
}

/**
 * 导航。刻意保持简单：房间列表 → 聊天。
 * 真原生的价值在体验与可靠性，不在导航层数多。
 */
@Composable
fun Nav(app: ChatApp) {
    var screen by remember { mutableStateOf<Screen>(Screen.Rooms) }

    when (val s = screen) {
        is Screen.Rooms -> RoomList(
            app,
            onPick = { id, name -> screen = Screen.Chat(id, name) },
            onSettings = { screen = Screen.Settings }
        )
        is Screen.Chat -> {
            val vm: ChatViewModel = viewModel()
            LaunchedEffect(s.id) { vm.open(s.id) }
            ChatScreen(vm, s.name, onBack = { screen = Screen.Rooms }) { vm.send(it) }
        }
        is Screen.Settings -> SettingsScreen(onBack = { screen = Screen.Rooms })
    }
}

sealed interface Screen {
    data object Rooms : Screen
    data class Chat(val id: String, val name: String) : Screen
    data object Settings : Screen
}

@Composable
fun RoomList(app: ChatApp, onPick: (String, String) -> Unit, onSettings: () -> Unit) {
    var rooms by remember { mutableStateOf(emptyList<io.liuyiming.chat.data.db.RoomEntity>()) }
    LaunchedEffect(Unit) { rooms = app.repo.rooms() }
    Column(Modifier.padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(Strings.t("rooms"), style = MaterialTheme.typography.headlineMedium)
            TextButton(onClick = onSettings) { Text(Strings.t("settings")) }
        }
        Spacer(Modifier.height(8.dp))
        rooms.forEach { r ->
            Text(r.name, modifier = Modifier
                .fillMaxWidth()
                .clickable { onPick(r.id, r.name) }
                .padding(vertical = 12.dp))
            HorizontalDivider()
        }
        if (rooms.isEmpty()) Text("还没有会话")
    }
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
         * 登录失败却不给提示，用户只会反复重试 ——
         * 而真正原因可能是"账号未审核""已被禁言""密码错了"，处置方式完全不同。
         */
        err?.let { Text(it, color = MaterialTheme.colorScheme.error) }

        Button(
            enabled = !busy && nick.isNotBlank() && pwd.isNotBlank(),
            onClick = {
                busy = true; err = null
                scope.launch {
                    val r = app.repo.login(nick.trim(), pwd)
                    busy = false
                    if (r.isSuccess) {
                        /* ★ 登录后必须把同步水位归零（S-144）。
                           登录前 SyncEngine 已经空转过若干次，
                           虽然已改为"未登录不同步"，但应用可能在旧水位上
                           残留过一次空同步；归零可确保这次一定走全量，
                           否则用户看到的房间会是空的 —— 而里面有几百条历史。 */
                        app.sync.reset()
                        onOk()
                    } else err = r.exceptionOrNull()?.message ?: "登录失败"
                }
            }
        ) { Text(if (busy) "登录中…" else "登录") }
    }
}
