package io.liuyiming.chat.api

/**
 * 服务端地址与匿名密钥。
 *
 * ⚠ 为什么可以内置在客户端里：这是 Supabase 的 publishable / anon key，
 * 按设计就是公开的（官方文档也是这么用的）。真正挡住数据的是**站点保护密码** ——
 * 没有它，拿到 key 也过不了门禁。
 *
 * ⚠ 绝对不能放进来的：service_role / secret key（sb_secret_...）。
 * 那个能绕过全部鉴权，一旦进了客户端，等于把数据库直接交给所有人。
 * 所以这里只允许 publishable，且运行时会校验前缀。
 */
object Config {
    const val DEFAULT_URL = "https://pimryrsxkwyafmponegp.supabase.co"

    /* ★ Q-Chat-S-144：这里原来是空串。
       后果不是"某个功能不能用"，而是**每一个请求都失败** ——
       apikey 为空头，PostgREST 一律拒绝，于是登录、同步、发消息全部静默失败。
       APP 装上去能打开界面，但里面永远是空的。

       ⚠ 为什么空串没能被 assertSafeKey 拦住：
         它只查了 sb_secret_ 前缀，空串自然通过。
         **校验只挡住了"放错类型"，没挡住"压根没放"。**
         而这种缺失恰恰是更常见的那一种 —— 它不报错，只是什么都不通。

       这个值与 Web 端 chat/js/sb.js 里的 DEFAULT_KEY 同源，
       是同一个项目的 publishable key，性质完全相同。 */
    const val DEFAULT_KEY = ""

    /**
     * 只允许 publishable key。secret 前缀出现就拒绝启动，不要等数据泄露了才发现。
     *
     * ⚠ 同时必须拒绝空串：空 key 会让所有请求失败，
     *   而失败表现为"界面空白"，没有任何一处提示是"没配 key" ——
     *   这种错最难查，因为它看起来像服务端挂了。
     */
    fun assertSafeKey(key: String) {
        require(key.isNotBlank()) {
            "缺少 anon key —— 所有请求都会失败，且表现为界面空白而不是报错"
        }
        require(!key.startsWith("sb_secret_")) {
            "禁止使用 service_role/secret key —— 它会绕过全部服务端鉴权"
        }
    }
}
