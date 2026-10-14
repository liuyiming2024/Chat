package io.liuyiming.chat.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.liuyiming.chat.ChatApp
import io.liuyiming.chat.data.db.MessageEntity
import io.liuyiming.chat.sync.Clock
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.util.UUID

class ChatViewModel(private val app: ChatApp) : ViewModel() {

    private val _roomId = MutableStateFlow<String?>(null)
    val roomId: StateFlow<String?> = _roomId

    val messages: StateFlow<List<MessageEntity>> = _roomId
        .filterNotNull()
        .flatMapLatest { id ->
            // 轮询本地库。SyncEngine 负责往库里写，这里只管读 —— 两端职责分开
            flow {
                while (true) { emit(app.db.messages().list(id)); delay(1_000) }
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** 发送失败提示。null = 正常。 */
    private val _sendError = MutableStateFlow<String?>(null)
    val sendError: StateFlow<String?> = _sendError

    private val _sending = MutableStateFlow(false)
    val sending: StateFlow<Boolean> = _sending

    fun open(roomId: String) { _roomId.value = roomId }

    /**
     * ⚠ 长度必须在发送**之前**校验（对应 Web 版 S-101）。
     *
     * 服务端限 8000 字。（NATIVE-MSG）不提前拦的话：用户写 12000 字一路顺畅发出去，
     * 被服务端拒绝才弹"消息过长" —— 而这时输入框已经清空了，内容没了。
     * 写了半小时的东西因为一个本可提前拦截的限制而丢失，是最不该发生的损失。
     */
    companion object { const val MAX_LEN = 8000 }

    fun send(text: String) {
        val room = _roomId.value ?: return
        val body = text.trim()
        if (body.isEmpty()) return
        if (body.length > MAX_LEN) {
            _sendError.value = "消息超过 ${MAX_LEN} 字（当前 ${body.length}），请分段发送"
            return
        }

        viewModelScope.launch {
            _sending.value = true
            _sendError.value = null
            val r = runCatching { app.repo.send(room, body) }
            _sending.value = false
            if (r.isFailure) {
                // 失败必须说清"已经入队，联网后自动补发"，
                // 而不是只说"发送失败" —— 用户会以为东西没了
                _sendError.value = "暂时发不出去，已存入待发队列，联网后自动补发"
            }
        }
    }

    /**
     * 撤回。
     *
     * ⚠ 时限两端都要判。Web 版曾经只在界面上挡着，
     * 直接调接口能撤回三个月前的任何消息 —— 前端判定只能决定按钮显不显示，
     * 服务端才是真正的闸门。这里前端判一次是为了给出**正确的提示**：
     * 超时后按钮不该凭空消失，否则用户只会以为功能坏了。
     */
    fun canRevoke(m: MessageEntity): Boolean {
        val limitMs = 6 * 60 * 1000L
        return (Clock.now() - m.at) <= limitMs
    }

    fun revoke(m: MessageEntity) {
        viewModelScope.launch {
            if (!canRevoke(m)) { _sendError.value = "已超过撤回时限（6 分钟）"; return@launch }
            runCatching {
                app.api.rpc("msg_delete", kotlinx.serialization.json.JsonObject(
                    mapOf("p_id" to kotlinx.serialization.json.JsonPrimitive(m.id))
                ))
            }
        }
    }
}
