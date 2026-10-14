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
fun ChatScreen(vm: ChatViewModel, roomName: String, onSend: (String) -> Unit) {
    val messages by vm.messages.collectAsState()
    val err by vm.sendError.collectAsState()
    val sending by vm.sending.collectAsState()
    var draft by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize()) {
        /**
         * ⚠ 发送失败必须常驻可见（对应 Web 版"自动保存失败静默"那条判据）。
         * 只弹一次 toast 的话，（NATIVE-MSG）用户在看别处就错过了，
         * 于是以为发出去了，其实一直在失败。常驻 + 说清去向（已入队）才够。
         */
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
        Text(m.body)
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
