package io.liuyiming.chat

import io.liuyiming.chat.core.Payload
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * Q-Chat-S-144：服务端载荷字段映射。
 *
 * ★ 为什么这些用例值得写：
 *   字段名写错是**静默失败** —— 不报错、不崩溃，只是那一列永远为空。
 *   原 SyncEngine 用下划线（room_id / from_id / created_at），
 *   服务端返回的是驼峰（room / from / ts），
 *   结果每条消息都被 `?: return null` 丢掉，
 *   用户看到的是一个完全空白的聊天窗口，而日志里什么都没有。
 *
 * ⚠ 下面的样本**逐字照抄 schema.sql 里 json_build_object 的键名**。
 *   改服务端的字段名时，这份测试必须一起改 —— 它存在的意义就是
 *   让"两端不一致"在 CI 上变成红色，而不是在用户手机上变成空白。
 */
class PayloadTest {

    private fun obj(src: String): JsonObject =
        Json.parseToJsonElement(src) as JsonObject

    // ---------- 水位 ----------

    @Test
    fun `state_peek 返回的是裸数字而不是对象`() {
        /* ★ 这条是同步能发生的**前提**。
           原代码写 `r as? JsonObject ?: return null`，
           而 PostgREST 下发的是 `12345` —— 于是 peek() 恒为 null，
           tick() 每次在第一行就 return，同步从未发生过。 */
        assertEquals(12345L, Payload.rev(JsonPrimitive(12345)))
        assertEquals(12345L, Payload.rev(Json.parseToJsonElement("12345")))
    }

    @Test
    fun `水位也兼容对象形态`() {
        assertEquals(7L, Payload.rev(obj("""{"rev":7}""")))
        assertEquals(7L, Payload.rev(obj("""{"state_peek":7}""")))
    }

    @Test
    fun `水位解析不出来时返回 null 而不是 0`() {
        /* 返回 0 会被当成"从未拉过"，于是每次都走全量，白花流量。 */
        assertNull(Payload.rev(JsonNull))
        assertNull(Payload.rev(obj("""{"foo":1}""")))
    }

    // ---------- 消息 ----------

    /** schema.sql state_get 的 messages 结构，原样搬过来。 */
    private val MSG = """{
        "id":"m1","room":"r1","from":"u1","type":"text",
        "text":"你好","mediaId":null,"name":null,"size":null,
        "replyTo":null,"deleted":false,"edited":null,"ts":1700000000000
    }"""

    @Test
    fun `消息按服务端驼峰字段解析`() {
        val m = Payload.message(obj(MSG))!!
        assertEquals("m1", m.id)
        assertEquals("r1", m.room)
        assertEquals("u1", m.from)
        assertEquals("text", m.kind)
        assertEquals("你好", m.body)
        assertEquals(1700000000000L, m.at)
        assertFalse(m.deleted)
    }

    @Test
    fun `消息缺 room 时必须丢弃`() {
        /* 没有 room 的消息插进库会显示在错误的房间里，
           这比丢一条消息更糟 —— 用户会在无关的对话里看到它。 */
        assertNull(Payload.message(obj("""{"id":"x","from":"u"}""")))
    }

    @Test
    fun `缺 rev 字段时不能把整条消息丢掉`() {
        /* 少一个字段 ≠ 少一条消息。原来一旦取不到就 return null，
           等于把"少一列"升级成"少一条"。 */
        val m = Payload.message(obj(MSG))
        assertNotNull(m)
        assertEquals(0L, m!!.rev)
    }

    @Test
    fun `字段全为 null 时不能抛异常`() {
        /* JsonNull.jsonPrimitive 会抛异常，一个 null 字段就能搞挂整次同步 */
        val m = Payload.message(obj("""{"id":"m2","room":"r1","from":null,
            "type":null,"text":null,"mediaId":null,"ts":null,"edited":null,"deleted":null}"""))
        assertNotNull(m)
        assertEquals("", m!!.from)
        assertFalse(m.deleted)
    }

    // ---------- 用户 ----------

    @Test
    fun `用户的 realName 与 status 要正确映射`() {
        val u = Payload.user(obj("""{"id":"u1","nick":"小明","realName":"申请理由",
            "role":"member","status":"pending","mutedUntil":null,"createdAt":111}"""))!!
        assertEquals("申请理由", u.real)
        /* ⚠ status 是字符串不是布尔。判错的话待审核的号会显示成正常成员。 */
        assertFalse("status=pending 不能当成已激活", u.active)
    }

    @Test
    fun `status 为 active 才算激活`() {
        val u = Payload.user(obj("""{"id":"u2","nick":"a","status":"active"}"""))!!
        assertTrue(u.active)
    }

    // ---------- 房间 ----------

    @Test
    fun `房间的 owner 与 roomMuted 要正确映射`() {
        val r = Payload.room(obj("""{"id":"r1","name":"公屏","owner":"u9",
            "admins":["u9"],"roomMuted":{"u5":1700000000000},"createdAt":222}"""))!!
        assertEquals("u9", r.owner)
        assertEquals(listOf("u9"), r.admins)
        /* ⚠ 禁言在服务端是"uid→到期时间"的字典，取的是键不是值。
           原代码取 "muted" 恒为空，被禁言的人完全看不出自己被禁了。 */
        assertEquals(listOf("u5"), r.muted)
    }

    // ---------- 时间校正 ----------

    @Test
    fun `serverNow 只在对象载荷里取`() {
        assertEquals(999L, Payload.serverNow(obj("""{"serverNow":999}""")))
        assertNull("裸数字没有 serverNow", Payload.serverNow(JsonPrimitive(999)))
    }
}
