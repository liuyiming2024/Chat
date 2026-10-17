package io.liuyiming.chat.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.liuyiming.chat.ChatApp
import io.liuyiming.chat.core.Rules
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
    /** 保留原常量名以免别处引用断掉，但真值只有 Rules 一处。 */
    companion object { const val MAX_LEN = Rules.MAX_LEN }

    fun send(text: String) {
        val room = _roomId.value ?: return
        val body = text.trim()
        if (body.isEmpty()) return
        // ⚠ 走 Rules，与单元测试是同一份判定 —— 不能在这里再写一遍 8000，
        //    否则改了 Rules 而这里没改，测试全绿但线上行为不一致。
        if (Rules.overLimit(text)) {
            _sendError.value = "消息超过 ${Rules.MAX_LEN} 字（当前 ${body.length}），请分段发送"
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
    fun canRevoke(m: MessageEntity): Boolean = Rules.canRevoke(m.at, Clock.now())

    /** 撤回剩余时间。<=0 表示已超时 —— 界面据此显示"已超时"而不是让按钮消失。 */
    fun revokeLeftMs(m: MessageEntity): Long = Rules.revokeLeftMs(m.at, Clock.now())

    /** 待发队列条数。>0 时界面上要让用户看见 —— 看不见等于没有。 */
    private val _pendingCount = MutableStateFlow(0)
    val pendingCount: StateFlow<Int> = _pendingCount

    private val _flushing = MutableStateFlow(false)
    val flushing: StateFlow<Boolean> = _flushing

    /** 每次进入聊天页、以及网络恢复时都刷一次。 */
    fun refreshPending() {
        viewModelScope.launch {
            _pendingCount.value = app.db.pending().all().size
        }
    }

    /**
     * 补发队列。
     *
     * ⚠ 两点：（NATIVE-PENDING）
     *   1. **成功后才删**（SyncEngine 里已保证）。发出去就删的话，
     *      网络刚断那一下请求其实没到服务端，本地却清了队列 —— 消息永久丢失。
     *   2. 补发结果**必须反映到界面**。静默补发的话，用户以为之前那条丢了，
     *      会再发一遍，对方收到两条一模一样的。
     */
    fun flushPending() {
        viewModelScope.launch {
            _flushing.value = true
            runCatching {
                app.sync.flushPending { item -> app.repo.send(item.room, item.body).isSuccess }
            }
            _flushing.value = false
            refreshPending()
        }
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
