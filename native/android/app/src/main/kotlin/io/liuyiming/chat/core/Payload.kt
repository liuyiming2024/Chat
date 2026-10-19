package io.liuyiming.chat.core

import io.liuyiming.chat.data.model.Message
import io.liuyiming.chat.data.model.Room
import io.liuyiming.chat.data.model.User
import kotlinx.serialization.json.*

/**
 * 服务端载荷 → 本地模型。**刻意不 import 任何 android.* 包**（同 Rules.kt），
 * 这样这些映射能在纯 JVM 上被单元测试覆盖。
 *
 * ★★ Q-Chat-S-144：这个文件存在的唯一理由是——**字段名对不上是静默失败**。
 *
 *   原 SyncEngine 读的是下划线命名（room_id / from_id / created_at / muted_until），
 *   而服务端 schema.sql 里 state_get / state_delta 返回的是驼峰
 *   （room / from / ts / mutedUntil …）。两边对不上时：
 *
 *     val x = ... ?: return@mapNotNull null
 *
 *   于是**每条消息都被丢弃**，而日志里一行异常都没有。
 *   用户看到的是一个能登录、能进房间、但永远空白的聊天窗口 ——
 *   他会以为"没人说话"，不会想到是解析错了。
 *
 *   ⚠ 这跟 Web 端 S-143（site 字段对不上导致无门模式失效）是同一类错，
 *     而且是**第二次出现**。跨端共用一份服务端契约时，
 *     任何一端凭记忆写字段名都迟早写错，所以这里集中一处，并加测试钉死。
 *
 * ⚠ 改这里的字段名前，先去 schema.sql 里 grep 对应的 json_build_object，
 *   以服务端为准。**不要反过来改服务端迁就客户端** ——
 *   同一份信息两个来源，迟早不一致。
 */
object Payload {

    /**
     * 同步水位。
     *
     * ⚠ state_peek() 的返回类型是 **bigint**，PostgREST 下发的是裸数字
     *   （`12345`），不是 `{"rev":12345}`。
     *   原写法 `r as? JsonObject ?: return null` 必然失败，
     *   于是 tick() 每次都在第一行就 return —— **同步从未发生过一次**。
     *   这里两种形态都收，避免以后服务端改返回类型时再次静默失效。
     */
    fun rev(el: JsonElement): Long? = when (el) {
        is JsonPrimitive -> el.content.toLongOrNull()
        is JsonObject -> (el["rev"] ?: el["state_peek"] ?: el["state_rev"]).asLong()
        else -> null
    }

    /**
     * 服务端时间（毫秒）。
     *
     * ⚠ 只在 state_get / state_delta 的载荷里有；state_peek 是裸数字，没有它。
     *   原代码只在 peek() 里找 serverNow，而那里永远找不到 ——
     *   于是 Clock.serverOffset 恒为 0，等于时间校正功能从未生效。
     */
    fun serverNow(o: JsonElement): Long? =
        (o as? JsonObject)?.long("serverNow")

    fun user(o: JsonObject): User? {
        val id = o.str("id") ?: return null
        return User(
            id = id,
            nick = o.str("nick") ?: "",
            role = o.str("role") ?: "member",
            /* 服务端字段叫 realName，不是 real */
            real = o.str("realName"),
            /* ⚠ 服务端给的是 status 字符串（active/pending/banned/rejected），
               不是 active 布尔。直接取布尔会恒为默认值 true ——
               于是待审核、已封禁的号在本地都显示成正常成员。 */
            active = o.str("status")?.let { it == "active" } ?: true,
            mutedUntil = o.long("mutedUntil"),
            createdAt = o.long("createdAt") ?: 0
        )
    }

    fun room(o: JsonObject): Room? {
        val id = o.str("id") ?: return null
        return Room(
            id = id,
            name = o.str("name") ?: "",
            /* 服务端叫 owner，不是 owner_id */
            owner = o.str("owner"),
            admins = o.strList("admins"),
            /* ⚠ 群内禁言在服务端是 roomMuted 对象（uid → 到期时间戳），
               不是 muted 数组。原代码取 "muted" 恒为空，
               于是被禁言的人在 APP 上完全看不出自己被禁了 ——
               他会一直发、一直发不出去，而界面不给任何提示。 */
            muted = o.objKeys("roomMuted"),
            createdAt = o.long("createdAt") ?: 0
        )
    }

    fun message(o: JsonObject): Message? {
        val id = o.str("id") ?: return null
        /* ⚠ 这两个缺一个就必须丢弃：room 用来归组，
           拿不到 room 的消息插进库里会永远显示在错误的房间里。 */
        val room = o.str("room_id") ?: return null
        return Message(
            id = id,
            room = room,
            from = o.str("from") ?: "",
            /* 服务端叫 type，不是 kind */
            kind = o.str("type") ?: "text",
            /* 服务端叫 text，不是 body */
            body = o.str("text") ?: "",
            /* 服务端叫 mediaId，不是 media */
            media = o.str("mediaId"),
            /* 服务端叫 ts，不是 created_at */
            at = o.long("ts") ?: 0,
            /* 服务端叫 edited（时间戳），不是 edited_at */
            editedAt = o.long("edited"),
            deleted = o.bool("deleted") ?: false,
            /* ⚠ state_get 的消息结构里目前没有 rev 字段。
               缺了不影响正确性（本地按 id 去重、按 at 排序），
               但不能因为取不到就把整条消息丢掉 —— 那是把"少一个字段"
               升级成"少一条消息"。 */
            rev = o.long("rev") ?: 0
        )
    }

    /* ---------- 取值辅助 ----------
     * ⚠ 统一用 `as? JsonPrimitive` 而不是 `.jsonPrimitive`：
     *   字段值为 null 时元素类型是 JsonNull，取 .jsonPrimitive 会抛异常，
     *   一个 null 字段就把整条记录（乃至整次同步）搞挂。 */
    private fun JsonObject.str(k: String): String? =
        (this[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

    private fun JsonObject.long(k: String): Long? = this[k].asLong()

    private fun JsonObject.bool(k: String): Boolean? =
        (this[k] as? JsonPrimitive)?.booleanOrNull

    private fun JsonObject.strList(k: String): List<String> =
        (this[k] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()

    /** 取对象的键集合。用于 roomMuted 这类"字典当集合用"的字段。 */
    private fun JsonObject.objKeys(k: String): List<String> =
        (this[k] as? JsonObject)?.keys?.toList() ?: emptyList()

    /* ⚠ 不自己定义 JsonPrimitive.longOrNull ——
       kotlinx.serialization 里已经有同名扩展，重复声明是编译错误
       （Conflicting overloads）。绕开它，直接用标准库的 String.toLongOrNull()。 */
    private fun JsonElement?.asLong(): Long? {
        val p = this as? JsonPrimitive ?: return null
        return p.content.toLongOrNull()
    }
}
