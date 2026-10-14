package io.liuyiming.chat.api

import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * 与服务端对话的唯一出口。
 *
 * 协议要点（从 Web 版 sb.js 逐条对齐，错一条就整个连不上）：
 *  1. anon key 放在 **apikey 头**。（NATIVE-ARCH）放进 Authorization: Bearer 会被网关当成 JWT 解析，
 *     而这个 key 不是 JWT → 报 Invalid JWT。这是最容易踩的一条。
 *  2. 用户身份用 **x-session 头**传 token（服务端查 sessions 表），不依赖网关解析 JWT。
 *  3. RPC 一律 POST 到 /rest/v1/rpc/<name>，body 是参数对象（没有参数也要给 {}）。
 */
class ApiClient(
    private val baseUrl: String,
    private val anonKey: String
) {
    init { Config.assertSafeKey(anonKey) }

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /** 会话令牌。null = 未登录。 */
    @Volatile
    var sessionToken: String? = null

    class ApiException(val status: Int, message: String) : IOException(message)

    /** body 里含明文密码，交给调用方决定要不要记。 */
    fun rpc(name: String, params: JsonObject = JsonObject(emptyMap())): JsonElement {
        val body = params.toString().toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url("$baseUrl/rest/v1/rpc/$name")
            .post(body)
            .apply {
                header("apikey", anonKey)
                header("Content-Type", "application/json")
                header("Accept", "application/json")
                sessionToken?.let { header("x-session", it) }
            }
            .build()

        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw ApiException(resp.code, parseErr(resp.code, text))
            if (text.isBlank()) return JsonNull
            return runCatching { json.parseToJsonElement(text) }
                .getOrDefault(JsonNull)
        }
    }

    /**
     * PostgREST 的错误是 {"message":..,"code":..} 或 {"error":..}，
     * 直接把整段 JSON 抛给用户会看到一堆看不懂的东西。
     * 取 message 字段，取不到再退化成状态码。
     */
    private fun parseErr(code: Int, text: String): String {
        val msg = runCatching {
            val o = json.parseToJsonElement(text) as? JsonObject
            o?.get("message")?.jsonPrimitive?.contentOrNull
                ?: o?.get("error")?.jsonPrimitive?.contentOrNull
        }.getOrNull()
        return msg ?: "请求失败（HTTP $code）"
    }
}
