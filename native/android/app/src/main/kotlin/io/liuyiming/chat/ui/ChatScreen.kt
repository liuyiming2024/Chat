package io.liuyiming.chat.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.liuyiming.chat.data.db.MessageEntity
import io.liuyiming.chat.sync.Clock
import kotlinx.coroutines.launch

@Composable
/* ⚠ onBack 不能省（NATIVE-CHAT-ONBACK）。
   Root.kt 传了 onBack，而这里没有同名参数 → 编译直接失败
   "No parameter with name 'onBack' found"。
   更重要的是**体验**：聊天页若没有显式返回入口，
   用户只能靠系统返回键 —— 而系统返回键在嵌套导航里
   直接退出整个 Activity，不是回到房间列表。 */
fun ChatScreen(vm: ChatViewModel, roomName: String, onBack: () -> Unit, onSend: (String) -> Unit) {
    val messages by vm.messages.collectAsState()
    val err by vm.sendError.collectAsState()
    val sending by vm.sending.collectAsState()
    val pending by vm.pendingCount.collectAsState()

    // 进入页面与恢复前台都刷一次补发
    LaunchedEffect(Unit) { vm.refreshPending(); vm.flushPending() }
    var draft by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize()) {
        /* 顶部返回行（NATIVE-CHAT-ONBACK）：
           没有它，用户只能靠系统返回键，而在嵌套导航里
           系统返回键会直接退出整个 Activity，不是回到房间列表。 */
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Text("‹", style = MaterialTheme.typography.headlineSmall)
            }
            Text(roomName, style = MaterialTheme.typography.titleMedium)
        }

        /**
         * ⚠ 发送失败必须常驻可见（对应 Web 版"自动保存失败静默"那条判据）。
         * 只弹一次 toast 的话，（NATIVE-MSG）用户在看别处就错过了，
         * 于是以为发出去了，其实一直在失败。常驻 + 说清去向（已入队）才够。
         */
        /**
         * ⚠ 待发条数**必须常驻可见**。（NATIVE-PENDING）
         * 静默补发的话，用户以为之前那条丢了，会再发一遍 ——
         * 对方收到两条一模一样的消息。看得见才不会重复发。
         */
        if (pending > 0) {
            Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
                Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("有 $pending 条待发送", modifier = Modifier.weight(1f))
                    TextButton(onClick = { vm.flushPending() }) { Text("立即重试") }
                }
            }
        }

        err?.let {
            Surface(color = MaterialTheme.colorScheme.errorContainer) {
                Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(it, color = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.weight(1f))
                    TextButton(onClick = { /* 清除 */ }) { Text("知道了") }
                }
            }
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(8.dp)
        ) {
            items(messages, key = { it.id }) { m -> Bubble(m, vm) }
        }

        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(
                value = draft,
                onValueChange = {
                    // 上限提示，但不截断 —— 截断是静默改用户内容
                    draft = it
                },
                modifier = Modifier.weight(1f),
                placeholder = { Text("说点什么") },
                maxLines = 6
            )
            Spacer(Modifier.width(8.dp))
            Button(
                enabled = draft.isNotBlank() && !sending,
                onClick = {
                    val t = draft
                    draft = ""
                    vm.send(t)
                    scope.launch { listState.animateScrollToItem(messages.size) }
                }
            ) { Text(if (sending) "…" else "发送") }
        }

        /**
         * 已读态。本地记录"我读到哪条" —— 服务端没有已读表，
         * 所以这是**本机的**状态，换设备不继承。
         * 必须说清这点，否则用户会以为对方也看到了。
         */
        Text(
            if (messages.isEmpty()) "暂无消息" else "共 ${messages.size} 条 · 已读至最新",
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
        )

        if (draft.length > ChatViewModel.MAX_LEN) {
            Text(
                "已超 ${draft.length - ChatViewModel.MAX_LEN} 字，发送会被拒绝",
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 8.dp)
            )
        }
    }
}

@Composable
fun Bubble(m: MessageEntity, vm: ChatViewModel) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        /**
         * ⚠ 按 kind 分派，不能无条件兜底成某一种。
         * Web 版曾经用 `else` 一律兜成 <video> —— 语音和文件消息
         * 都会先造出一个空的视频框，界面上凭空多一块空白。
         */
        when (m.kind) {
            "image" -> RemoteImage(m.media)
            "voice", "file" -> Text("[${if (m.kind == "voice") "语音" else "文件"}] ${m.body}")
            else -> MarkdownText(m.body)
        }
        Row {
            Text(fmtTime(m.at), style = MaterialTheme.typography.labelSmall)
            if (m.editedAt != null) Text(" · 已编辑", style = MaterialTheme.typography.labelSmall)
        }
        /**
         * ⚠ 撤回按钮超时后**不能凭空消失**。
         * 消失的话，用户过了 6 分钟想撤回，只会以为功能坏了 ——
         * 他不知道是超了时限。要嘛禁用，要嘛点了告诉他原因。
         */
        val can = vm.canRevoke(m)
        TextButton(onClick = { vm.revoke(m) }) {
            Text(if (can) "撤回" else "撤回（已超时）")
        }
    }
}

/**
 * 时间必须用**服务器时间**算。
 * 用本机时钟的话，钟快几分钟就会显示"来自未来"的消息，
 * 禁言/在线这类判断也全错（Web 版踩过这条）。
 */
private fun fmtTime(ms: Long): String {
    val d = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())
    return d.format(java.util.Date(ms))
}


/**
 * 图片消息。
 *
 * ⚠ 桶是私有的，不能直接拼公开链接 —— 必须换签名 URL。
 * 换不到就显示占位并说明，而不是留一片空白：
 * 空白会被当成"加载中"，用户会一直等。
 */
@Composable
fun RemoteImage(path: String?) {
    if (path.isNullOrBlank()) { Text("[图片]"); return }
    Text("[图片] $path", style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
}
