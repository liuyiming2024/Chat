package io.liuyiming.chat

import io.liuyiming.chat.api.Config
import org.junit.Assert.*
import org.junit.Test

/**
 * Q-Chat-S-144：服务端凭据的**存在性**校验。
 *
 * ★ 为什么连"有没有配"都要写测试：
 *   S-144 发现的第一个致命问题就是 DEFAULT_KEY 是空串。
 *   它的表现不是报错，而是**每个请求都失败、界面一片空白** ——
 *   看起来像服务端挂了，于是排查方向整个跑偏。
 *
 *   而原来的 assertSafeKey 只查了 sb_secret_ 前缀，
 *   空串理所当然地通过了校验。
 *   **校验挡住了"放错类型"，没挡住"压根没放"**，
 *   而后一种恰恰更常见、也更难查。
 */
class ConfigTest {

    @Test
    fun `内置默认 key 不能为空`() {
        /* ★ 这条直接钉死 S-144 那个致命 bug。
           谁再把 DEFAULT_KEY 清掉，CI 立刻变红，
           而不是等到用户装上去发现界面全空。 */
        assertTrue(
            "DEFAULT_KEY 为空 —— 所有请求都会失败，且表现为界面空白",
            Config.DEFAULT_KEY.isNotBlank()
        )
    }

    @Test
    fun `内置默认地址不能为空`() {
        assertTrue(Config.DEFAULT_URL.isNotBlank())
    }

    @Test
    fun `空 key 必须被拒绝`() {
        assertThrows(IllegalArgumentException::class.java) { Config.assertSafeKey("") }
    }

    @Test
    fun `纯空白 key 也必须被拒绝`() {
        /* isNotBlank 而不是 isNotEmpty —— 只有空格同样过不了网关 */
        assertThrows(IllegalArgumentException::class.java) { Config.assertSafeKey("   ") }
    }

    @Test
    fun `secret key 必须被拒绝`() {
        assertThrows(IllegalArgumentException::class.java) {
            Config.assertSafeKey("sb_secret_abc123")
        }
    }

    @Test
    fun `publishable key 放行`() {
        Config.assertSafeKey("sb_publishable_ok")
    }
}
