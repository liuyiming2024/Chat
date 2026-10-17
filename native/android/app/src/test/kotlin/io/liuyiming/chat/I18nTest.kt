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
     * ⚠ 这条原写成"中英文值应相等" —— **那是错的**，两个词典里都有的 key
     *   值本来就该不同（"发送" vs "Send"）。而且"英文缺 key"这个场景
     *   **根本构造不出来**：init 里的双向校验保证了不可能有单缺的 key。
     *
     *   所以它真正该测的是：**两种语言下每个 key 都取得到非空值**。
     *   这才是"不会露出空白"的实际保证，也是能验证的。
     *
     * ⚠ 遍历 Strings.keys 而不是硬编码清单 —— 硬编码那份会与词典脱节，
     *   变成"测了个过时清单"，加新词条测不到、删了还在测（假绿）。
     */
    @Test fun `两种语言下每个词条都取得到非空值`() {
        val keys = Strings.keys
        assertTrue("词典不该为空", keys.isNotEmpty())

        I18n.set(I18n.ZH)
        for (k in keys) assertFalse("中文缺 key: $k", Strings.t(k).isEmpty())

        I18n.set(I18n.EN)
        for (k in keys) assertFalse("英文缺 key: $k", Strings.t(k).isEmpty())
    }

    /** 切换语言后必须立刻生效 —— Web 端踩过"切了不重绘，用户以为点了没用"。 */
    @Test fun `切换语言立刻生效`() {
        I18n.set(I18n.ZH)
        val zh = Strings.t("send")
        I18n.set(I18n.EN)
        val en = Strings.t("send")
        assertNotEquals(zh, en)
    }

    @Test fun `超长限制文案含具体数字`() {
        I18n.set(I18n.ZH)
        assertTrue(Strings.t("over_limit").contains("8000"))
    }
}
