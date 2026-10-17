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
