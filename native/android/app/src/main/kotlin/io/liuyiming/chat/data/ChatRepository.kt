package io.liuyiming.chat.data

import io.liuyiming.chat.api.ApiClient
import io.liuyiming.chat.data.db.*
import kotlinx.serialization.json.*
import java.util.UUID

class ChatRepository(
    private val api: ApiClient,
    private val db: AppDatabase
) {
    /** 登录。成功后把 token 交给 ApiClient —— 之后所有请求自动带上 x-session。 */
    fun login(nick: String, pwd: String): Result<String> = runCatching {
        val res = api.rpc("user_login", JsonObject(mapOf(
            "p_nick" to JsonPrimitive(nick),
            "p_pwd"  to JsonPrimitive(pwd)
        )))
        val o = res as? JsonObject ?: error("服务端返回格式异常")
        val token = o["token"]?.jsonPrimitive?.contentOrNull ?: error("未返回会话令牌")
        api.sessionToken = token
        token
    }

    fun logout() {
        runCatching { api.rpc("logout", JsonObject(emptyMap())) }
        api.sessionToken = null
    }

    /**
     * 发消息。
     *
     * ⚠ 离线必须入队 —— Web 版曾经只在界面上写一句"已发送"却不入队，
     * 联网后也不补发，对方永远收不到，而本机看着是发出去了。
     * 这是"静默丢消息"最典型的一种。
     */
    suspend fun send(roomId: String, body: String): Result<Unit> = runCatching {
        val localId = UUID.randomUUID().toString()
        db.pending().add(PendingEntity(localId, roomId, "text", body, null, System.currentTimeMillis()))
        api.rpc("msg_send", JsonObject(mapOf(
            "p_room" to JsonPrimitive(roomId),
            "p_kind" to JsonPrimitive("text"),
            "p_body" to JsonPrimitive(body)
        )))
        db.pending().remove(localId)
    }

    suspend fun messages(roomId: String) = db.messages().list(roomId)
    suspend fun rooms() = db.rooms().all()
    suspend fun users() = db.users().all()
}
