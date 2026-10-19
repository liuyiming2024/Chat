package io.liuyiming.chat.data

import io.liuyiming.chat.api.ApiClient
import io.liuyiming.chat.core.Rules
import io.liuyiming.chat.data.db.*
import kotlinx.serialization.json.*
import java.util.UUID

class ChatRepository(
    private val api: ApiClient,
    private val db: AppDatabase
) {
    /**
     * 登录。成功后把 token 交给 ApiClient —— 之后所有请求自动带上 x-session。
     *
     * ★ Q-Chat-S-143：凭证失败时服务端【返回 {ok:false, err}】而不是抛异常
     *   （plpgsql 里 raise 会回滚写入，那样失败计数记不上，限流就形同虚设）。
     *   所以这里**必须先检查 ok 字段**，不能只看 token 在不在。
     *
     *   原写法只取 token，拿不到就报"未返回会话令牌"。
     *   于是下面这些完全不同的原因，在界面上长得一模一样：
     *     · 昵称或密码错误
     *     · 账号待站长审核
     *     · 该账号已被封禁
     *     · 尝试次数过多，请 15 分钟后再试（被限流）
     *   Root.kt 的注释本来就把这个道理写清楚了
     *   ——"处置方式完全不同"，但代码没实现它。
     *   **注释里写了原则、代码里没落地，等于没有原则。**
     *   最糟的是限流那条：用户会以为自己记错密码，继续试，越试越被挡。
     */
    fun login(nick: String, pwd: String): Result<String> = runCatching {
        val res = api.rpc("user_login", JsonObject(mapOf(
            "p_nick" to JsonPrimitive(nick),
            "p_pwd"  to JsonPrimitive(pwd)
        )))
        val o = res as? JsonObject ?: error("服务端返回格式异常")
        val (good, value) = Rules.parseLogin(
            ok    = o["ok"]?.jsonPrimitive?.booleanOrNull,
            err   = o["err"]?.jsonPrimitive?.contentOrNull,
            token = o["token"]?.jsonPrimitive?.contentOrNull
        )
        if (!good) error(value)
        api.sessionToken = value
        value
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
