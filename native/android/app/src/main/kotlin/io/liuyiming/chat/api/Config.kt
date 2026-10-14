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
    const val DEFAULT_KEY = ""

    /** 只允许 publishable key。secret 前缀出现就拒绝启动，不要等数据泄露了才发现。 */
    fun assertSafeKey(key: String) {
        require(!key.startsWith("sb_secret_")) {
            "禁止使用 service_role/secret key —— 它会绕过全部服务端鉴权"
        }
    }
}
