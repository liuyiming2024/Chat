package io.liuyiming.chat.sync

import io.liuyiming.chat.api.ApiClient
import io.liuyiming.chat.core.Payload
import io.liuyiming.chat.data.db.*
import io.liuyiming.chat.data.model.*
import kotlinx.coroutines.*
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*

/**
 * 同步引擎。这是原生端最该小心的一块 —— Web 版在这里踩过的坑，
 * 每一行都得原样避开。
 *
 * 协议（与 Web 版 online.js 一致）：
 *   首次   state_get()          全量
 *   之后   state_peek()         只比序号，变了才拉
 *          state_delta(since)   增量
 *
 * ⚠ 比序号必须用 state_peek，不能用 state_seq ——（NATIVE-ARCH）
 *   后者是 nextval，会自己把序号改掉，于是每次轮询都以为"有更新"，
 *   白拉一遍全量。
 */
class SyncEngine(
    private val api: ApiClient,
    private val db: AppDatabase
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 当前水位。为 0 表示从未拉过，走全量。 */
    private var rev: Long = 0
    private var started = false

    /** 后台降频：App 在后台时把轮询拉长。省电，也省免费额度。 */
    @Volatile
    var foreground: Boolean = true

    fun start() {
        if (started) return
        started = true
        scope.launch {
            rev = db.sync().rev() ?: 0
            while (isActive) {
                runCatching { tick() }
                delay(if (foreground) 3_000L else 30_000L)
            }
        }
    }

    fun stop() { started = false; scope.cancel() }

    /**
     * ★ Q-Chat-S-144：未登录时**绝不能同步**。
     *
     *   原实现在 Application.onCreate 里就 start()，此时还没有会话。
     *   未登录时 state_get 返回的是空载荷（users/rooms/messages 全空），
     *   但 tick() 照旧把 rev 推进到了服务端水位。
     *   等用户登录后再拉增量，since 已经是"刚刚"——
     *   **历史消息一条都拉不到**，用户看到的是一个空房间，
     *   而实际上里面有几百条。
     *   这种"有数据但看不见"比报错更难发现。
     */
    private suspend fun tick() {
        if (api.sessionToken.isNullOrBlank()) return

        val serverRev = peek() ?: return
        if (serverRev <= rev) return            // 没变化就什么都不做

        val payload = if (rev == 0L) api.rpc("state_get", JsonObject(emptyMap()))
        else api.rpc("state_delta", JsonObject(mapOf("p_since" to JsonPrimitive(rev))))

        apply(payload)
        rev = serverRev
        db.sync().save(SyncStateEntity(rev = rev))
    }

    /**
     * 登录后调用：水位归零，下一次 tick 走全量。
     *
     * ⚠ 不归零的话，登录前那次空同步已经把 rev 推高了，
     *   登录后只会拉增量 —— 历史消息永远补不回来。
     */
    fun reset() { rev = 0 }

    private suspend fun peek(): Long? {
        val r = api.rpc("state_peek", JsonObject(emptyMap()))
        return Payload.rev(r)
    }

    private suspend fun apply(root: JsonElement) {
        val o = root as? JsonObject ?: return

        /* ⚠ 时间校正只能在这里做。
           原代码在 peek() 里找 serverNow，而 state_peek 返回的是裸数字、
           根本不含这个字段 —— 于是 Clock.serverOffset 恒为 0，
           时间校正从来没生效过（Web 版踩过同款坑：本机钟快 5 分钟
           会让所有人永远显示离线）。 */
        Payload.serverNow(o)?.let { Clock.serverOffset = it - System.currentTimeMillis() }

        /* ⚠ 一律用 `as? JsonArray` 而不是 `.jsonArray`：
           后者在类型不符时抛异常。而服务端在部分分支下
           messages 返回的是对象 `{}` 而不是数组 ——
           一个类型断言就让整次同步崩掉，太脆。 */
        (o["users"] as? JsonArray)?.let { arr ->
            db.users().upsertAll(arr.mapNotNull { e ->
                (e as? JsonObject)?.let(Payload::user)?.toEntity()
            })
        }

        (o["rooms"] as? JsonArray)?.let { arr ->
            db.rooms().upsertAll(arr.mapNotNull { e ->
                (e as? JsonObject)?.let(Payload::room)?.toEntity()
            })
        }

        /**
         * ⚠ 消息是**增量**的，绝不能先清库再插。
         * 清库的瞬间如果正好有 UI 在读，用户会看到聊天记录整个消失一下再出现；
         * 更糟的是清完插入失败，记录就真没了。用 upsert，主键相同就覆盖。
         */
        (o["messages"] as? JsonArray)?.let { arr ->
            db.messages().upsertAll(arr.mapNotNull { e ->
                (e as? JsonObject)?.let(Payload::message)?.toEntity()
            })
        }
    }

    /* ---------- model → entity ----------
     * 放在这里而不是 Payload 里：Entity 带 @Entity 注解，
     * 一旦被 Payload 引用，那些解析函数就再也没法在纯 JVM 上测了。 */
    private fun User.toEntity() = UserEntity(
        id = id, nick = nick, role = role, real = real,
        active = active, mutedUntil = mutedUntil, createdAt = createdAt
    )

    private fun Room.toEntity() = RoomEntity(
        id = id, name = name, owner = owner,
        admins = admins.toJson(), muted = muted.toJson(), createdAt = createdAt
    )

    private fun Message.toEntity() = MessageEntity(
        id = id, room = room, from = from, kind = kind, body = body,
        media = media, at = at, editedAt = editedAt, deleted = deleted, rev = rev
    )

    private fun List<String>.toJson(): String =
        Json.Default.encodeToString(ListSerializer(JsonPrimitive.serializer()), map { JsonPrimitive(it) })

    /**
     * 补发离线队列。
     *
     * ⚠ 必须**成功后才删**。"发出去就删"是最典型的丢消息写法：
     * 网络刚断的那一下，请求其实没到服务端，本地却已经把队列清了。
     */
    suspend fun flushPending(sender: suspend (PendingEntity) -> Boolean) {
        db.pending().all().forEach { item ->
            val ok = runCatching { sender(item) }.getOrDefault(false)
            if (ok) db.pending().remove(item.localId)
        }
    }

    private fun JsonObject.str(k: String): String? =
        this[k]?.jsonPrimitive?.contentOrNull
}

/**
 * 服务器时间与本机时钟的偏差。
 *
 * 为什么必须有：在线状态、禁言到期、消息排序都用时间戳判断。
 * 本机时钟快 5 分钟，所有人永远显示离线；慢 5 分钟则永远在线。
 * 用本机时钟做这类判断是错的（Web 版踩过），统一走这里。
 */
object Clock {
    @Volatile
    var serverOffset: Long = 0
    fun now(): Long = System.currentTimeMillis() + serverOffset
}
