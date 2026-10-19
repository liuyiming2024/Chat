package io.liuyiming.chat

import io.liuyiming.chat.core.Rules
import org.junit.Assert.*
import org.junit.Test

/**
 * NATIVE-TEST：把"能编译"推进到"行为被验证过"。
 *
 * ⚠ 这些用例刻意只测**规则**，不测 UI。
 * 原因：UI 要 Robolectric 或模拟器，CI 上开模拟器慢且脆；
 * 而真正容易写错、错了代价又大的，恰恰是这些纯判定。
 */
class RulesTest {

    // ---------- 长度 ----------

    @Test fun `刚好到上限不算超长`() {
        val s = "字".repeat(Rules.MAX_LEN)
        assertFalse(Rules.overLimit(s))
        assertEquals(0, Rules.remaining(s))
    }

    @Test fun `超过一个字就算超长`() {
        val s = "字".repeat(Rules.MAX_LEN + 1)
        assertTrue(Rules.overLimit(s))
        assertEquals(0, Rules.remaining(s)) // 不为负 —— 界面上显示"-1 字"是明显错误
    }

    /** ⚠ 这条是口径一致性的守卫：发送前会 trim，判定也必须按 trim 后算。 */
    @Test fun `前后空白不计入长度`() {
        val pad = " ".repeat(100)
        val s = pad + "字".repeat(Rules.MAX_LEN) + pad
        assertFalse(Rules.overLimit(s))
    }

    /**
     * ⚠ 这条**钉死口径**，不是重复测长度。
     *
     * 上面几条都用 `Rules.MAX_LEN` 做 repeat —— 好处是改常量不会牵连一堆用例，
     * 坏处是**改常量时测试完全无感**：把 8000 悄悄改成 800，17 条全绿，
     * 而服务端上限仍是 8000 —— 两端脱节，用户写 3000 字被客户端拦下，
     * 或者客户端放行 2000 字被服务端拒（取决于改大还是改小）。
     *
     * 所以必须有一条直接断言"常量等于服务端的 8000"。
     * 改这个值必须是**刻意同步服务端**的行为，不能是随手一改。
     */
    @Test fun `上限必须等于服务端的 8000`() {
        assertEquals(8000, Rules.MAX_LEN)
    }

    @Test fun `撤回时限必须是 6 分钟`() {
        assertEquals(6 * 60 * 1000L, Rules.REVOKE_WINDOW_MS)
    }

    @Test fun `空消息不算超长`() {
        assertFalse(Rules.overLimit(""))
        assertEquals(Rules.MAX_LEN, Rules.remaining(""))
    }

    // ---------- 撤回时限 ----------

    @Test fun `刚发出的能撤`() {
        assertTrue(Rules.canRevoke(at = 1_000_000, now = 1_000_000))
    }

    @Test fun `临界点仍可撤`() {
        val at = 1_000_000L
        val now = at + Rules.REVOKE_WINDOW_MS
        assertTrue(Rules.canRevoke(at, now))
        assertEquals(0, Rules.revokeLeftMs(at, now))
    }

    @Test fun `过一毫秒就撤不掉`() {
        val at = 1_000_000L
        val now = at + Rules.REVOKE_WINDOW_MS + 1
        assertFalse(Rules.canRevoke(at, now))
    }

    /** ⚠ 这条防的是"改了规则忘了改提示"：超时后剩余为负，界面才标"已超时"。 */
    @Test fun `超时后剩余为负`() {
        val at = 1_000_000L
        val now = at + Rules.REVOKE_WINDOW_MS + 60_000
        assertTrue(Rules.revokeLeftMs(at, now) < 0)
    }

    @Test fun `未来时间的消息不会因负数溢出而变成可撤`() {
        // 时钟比消息还早（服务端时间偏移导致）—— 不应异常，且应判为可撤
        assertTrue(Rules.canRevoke(at = 2_000_000, now = 1_000_000))
    }
}

/*
 * Q-Chat-S-143：登录响应解析。
 *
 * ★ 为什么要测这个：
 *   服务端凭证失败返回 {ok:false, err} 而不是抛异常，
 *   只看 token 在不在的话，四种原因会塌成同一句提示。
 *   而被限流那条伪装成"密码错误"，会让用户朝错误的方向自救。
 */
class LoginParseTest {

    @Test
    fun `凭证失败时原样透传服务端原因`() {
        val (ok, msg) = Rules.parseLogin(ok = false, err = "昵称或密码错误", token = null)
        assertFalse(ok)
        assertEquals("昵称或密码错误", msg)
    }

    @Test
    fun `被限流必须说明是被限流而不是密码错`() {
        /* 这条最要紧：如果提示成"密码错误"，
           用户会以为自己记错了，继续试，于是越试越被挡。 */
        val (ok, msg) = Rules.parseLogin(ok = false, err = "尝试次数过多，请 15 分钟后再试", token = null)
        assertFalse(ok)
        assertTrue(msg.contains("15 分钟"), "限流提示必须保留等待时长：$msg")
        assertFalse(msg.contains("密码错误"), "限流不能被伪装成密码错误：$msg")
    }

    @Test
    fun `待审核与已封禁必须各自保留自身措辞`() {
        val pending = Rules.parseLogin(ok = false, err = "账号待站长审核，请稍候", token = null)
        val banned  = Rules.parseLogin(ok = false, err = "该账号已被封禁", token = null)
        assertTrue(pending.second.contains("审核"))
        assertTrue(banned.second.contains("封禁"))
        assertNotEquals(pending.second, banned.second)
    }

    @Test
    fun `成功时返回 token`() {
        val (ok, msg) = Rules.parseLogin(ok = true, err = null, token = "abc123")
        assertTrue(ok)
        assertEquals("abc123", msg)
    }

    @Test
    fun `ok 缺失但 token 存在时按成功处理`() {
        /* 兼容：老契约只在失败时带 ok 字段 */
        val (ok, msg) = Rules.parseLogin(ok = null, err = null, token = "tk")
        assertTrue(ok)
        assertEquals("tk", msg)
    }

    @Test
    fun `ok 为 false 但 err 为空时不能返回空提示`() {
        /* 空提示比错提示更糟：用户看到一个空白的错误框，无从下手 */
        val (ok, msg) = Rules.parseLogin(ok = false, err = "   ", token = null)
        assertFalse(ok)
        assertTrue(msg.isNotBlank(), "不能给出空白提示")
    }

    @Test
    fun `ok 为 true 却没有 token 时必须报错而不是当作成功`() {
        val (ok, msg) = Rules.parseLogin(ok = true, err = null, token = null)
        assertFalse(ok, "没拿到 token 不能算登录成功")
        assertTrue(msg.isNotBlank())
    }
}
