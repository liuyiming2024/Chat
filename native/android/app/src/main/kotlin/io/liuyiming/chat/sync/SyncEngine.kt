package io.liuyiming.chat.sync

import io.liuyiming.chat.api.ApiClient
import io.liuyiming.chat.data.db.*
import kotlinx.coroutines.*
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

    private suspend fun tick() {
        val serverRev = peek() ?: return
        if (serverRev <= rev) return            // 没变化就什么都不做

        val payload = if (rev == 0L) api.rpc("state_get", JsonObject(emptyMap()))
        else api.rpc("state_delta", JsonObject(mapOf("p_since" to JsonPrimitive(rev))))

        apply(payload)
        rev = serverRev
        db.sync().save(SyncStateEntity(rev = rev))
    }

    private suspend fun peek(): Long? {
        val r = api.rpc("state_peek", JsonObject(emptyMap()))
        val o = r as? JsonObject ?: return null
        // 时间校正：本机时钟不准会让"在线/离线"判断全错（Web 版踩过）
        o["serverNow"]?.jsonPrimitive?.contentOrNull
            ?.toLongOrNull()
            ?.let { Clock.serverOffset = it - System.currentTimeMillis() }
        return (o["rev"] ?: o["state_rev"])?.jsonPrimitive?.contentOrNull?.toLongOrNull()
    }

    private suspend fun apply(root: JsonElement) {
        val o = root as? JsonObject ?: return

        o["users"]?.jsonArray?.let { arr ->
            db.users().upsertAll(arr.mapNotNull { u ->
                val x = u as? JsonObject ?: return@mapNotNull null
                UserEntity(
                    id = x.str("id") ?: return@mapNotNull null,
                    nick = x.str("nick") ?: "",
                    role = x.str("role") ?: "member",
                    real = x.str("real"),
                    active = x["active"]?.jsonPrimitive?.booleanOrNull ?: true,
                    mutedUntil = x.str("muted_until")?.toLongOrNull(),
                    createdAt = x.str("created_at")?.toLongOrNull() ?: 0
                )
            })
        }

        o["rooms"]?.jsonArray?.let { arr ->
            db.rooms().upsertAll(arr.mapNotNull { r ->
                val x = r as? JsonObject ?: return@mapNotNull null
                RoomEntity(
                    id = x.str("id") ?: return@mapNotNull null,
                    name = x.str("name") ?: "",
                    owner = x.str("owner_id"),
                    admins = (x["admins"]?.jsonArray ?: JsonArray(emptyList())).toString(),
                    muted = (x["muted"]?.jsonArray ?: JsonArray(emptyList())).toString(),
                    createdAt = x.str("created_at")?.toLongOrNull() ?: 0
                )
            })
        }

        /**
         * ⚠ 消息是**增量**的，绝不能先清库再插。
         * 清库的瞬间如果正好有 UI 在读，用户会看到聊天记录整个消失一下再出现；
         * 更糟的是清完插入失败，记录就真没了。用 upsert，主键相同就覆盖。
         */
        o["messages"]?.jsonArray?.let { arr ->
            db.messages().upsertAll(arr.mapNotNull { m ->
                val x = m as? JsonObject ?: return@mapNotNull null
                MessageEntity(
                    id = x.str("id") ?: return@mapNotNull null,
                    room = x.str("room_id") ?: return@mapNotNull null,
                    from = x.str("from_id") ?: "",
                    kind = x.str("kind") ?: "text",
                    body = x.str("body") ?: "",
                    media = x.str("media"),
                    at = x.str("created_at")?.toLongOrNull() ?: 0,
                    editedAt = x.str("edited_at")?.toLongOrNull(),
                    deleted = x["deleted"]?.jsonPrimitive?.booleanOrNull ?: false,
                    rev = x["rev"]?.jsonPrimitive?.longOrNull ?: 0
                )
            })
        }
    }

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
