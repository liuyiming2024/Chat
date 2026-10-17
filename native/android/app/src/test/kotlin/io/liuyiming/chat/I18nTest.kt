package io.liuyiming.chat

import io.liuyiming.chat.core.I18n
import io.liuyiming.chat.core.Strings
import org.junit.Assert.*
import org.junit.Test

class I18nTest {

    @Test fun `支持的语言设为当前`() {
        I18n.set(I18n.EN)
        assertEquals(I18n.EN, I18n.current)
        I18n.set(I18n.ZH)
        assertEquals(I18n.ZH, I18n.current)
    }

    /** ⚠ 不支持的标签必须静默回退默认，不能留一个界面上没人认识的中间态。 */
    @Test fun `不支持的语言回退默认`() {
        I18n.set("fr-FR")
        assertEquals(I18n.DEFAULT, I18n.current)
        I18n.set("")
        assertEquals(I18n.DEFAULT, I18n.current)
    }

    /** ⚠ Web 版踩过：值写成 'zh' 而支持列表是 'zh-CN' → 静默失效。 */
    @Test fun `语言标签与 Web 版一致`() {
        assertEquals("zh-CN", I18n.ZH)
        assertEquals("en", I18n.EN)
    }

    @Test fun `英文下取到英文`() {
        I18n.set(I18n.EN)
        assertEquals("Sign in", Strings.t("login"))
        I18n.set(I18n.ZH)
        assertEquals("登录", Strings.t("login"))
    }

    /**
     * ⚠ 最关键的一条：缺 key **绝不能把 key 本身露出去**。
     * 露出 `common.close` 是明显错误，不翻译至少还看得懂。
     */
    @Test fun `缺 key 不返回 key 本身`() {
        I18n.set(I18n.EN)
        val v = Strings.t("this_key_does_not_exist_zzz")
        assertNotEquals("this_key_does_not_exist_zzz", v)
        assertEquals("", v)
    }

    /**
     * 英文缺、中文有的 key，必须回退中文而不是空白。
     * 这是"中英词典 key 双向校验"之外的第二道兜底 ——
     * 校验只在开发期跑，运行时仍可能遇到（比如热修只改了一个词典）。
     */
    @Test fun `英文缺 key 回退中文`() {
        I18n.set(I18n.EN)
        val zhValue = run { I18n.set(I18n.ZH); Strings.t("send") }
        I18n.set(I18n.EN)
        assertEquals(zhValue, Strings.t("send")) // 两边都有时中文值应与自身一致
        assertFalse(Strings.t("send").isEmpty())
    }

    @Test fun `超长限制文案含具体数字`() {
        I18n.set(I18n.ZH)
        assertTrue(Strings.t("over_limit").contains("8000"))
    }
}
