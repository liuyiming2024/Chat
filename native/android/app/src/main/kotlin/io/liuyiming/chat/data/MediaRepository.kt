package io.liuyiming.chat.data

import io.liuyiming.chat.api.ApiClient
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File

/**
 * 媒体上传。三步协议（与 Web 版 online.js 完全一致）：
 *
 *   media_prepare(room,name,size) → 拿到槽位 {id, path}
 *   POST /storage/v1/object/media/<path>  → 传字节
 *   media_commit(id)                      → 标记 committed=true
 *
 * ⚠ 为什么要三步而不是直接传（NATIVE-MEDIA）：桶是私有的，且本项目用自建会话
 *   （拿不到 Supabase Auth 的 JWT），所以必须服务端先开槽、最后确认。
 *
 * ⚠ 第三步绝对不能省。省了的话：字节传上去了，但 media 表里那行
 *   committed 还是 false —— 会被 session_cleanup 当"用户中途放弃的上传"
 *   在 24 小时后清掉，于是消息里的图片变成永久坏图，
 *   而当时界面上明明白白提示"已发送"。
 */
class MediaRepository(private val api: ApiClient, private val baseUrl: String, private val anonKey: String) {

    private val json = Json { ignoreUnknownKeys = true }
    private val http = okhttp3.OkHttpClient.Builder()
        .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
        .writeTimeout(120, java.util.concurrent.TimeUnit.SECONDS)
        .build()

    fun upload(roomId: String, file: File, mime: String): Result<String> = runCatching {
        val slot = api.rpc("media_prepare", JsonObject(mapOf(
            "p_room" to JsonPrimitive(roomId),
            "p_name" to JsonPrimitive(file.name),
            "p_size" to JsonPrimitive(file.length())
        ))) as? JsonObject ?: error("申请上传槽位失败")

        val path = slot["path"]?.jsonPrimitive?.contentOrNull ?: error("槽位未返回路径")
        val id = slot["id"]?.jsonPrimitive?.contentOrNull ?: error("槽位未返回 id")

        putBytes(path, file, mime)
        api.rpc("media_commit", JsonObject(mapOf("p_id" to JsonPrimitive(id))))
        path
    }

    private fun putBytes(path: String, file: File, mime: String) {
        val body = file.asRequestBody(mime.toMediaTypeOrNull())
        val req = Request.Builder()
            .url("$baseUrl/storage/v1/object/media/$path")
            .post(body)
            .apply {
                header("apikey", anonKey)
                header("x-upsert", "true")
                api.sessionToken?.let { header("x-session", it) }
            }
            .build()
        http.newCall(req).execute().use { r ->
            if (!r.isSuccessful) error("上传失败（HTTP ${r.code}）")
        }
    }

    /**
     * 换签名 URL。桶私有，不能拼公开链接。
     * 本地没有的媒体（换设备、清缓存）走这里解析。
     */
    fun resolve(path: String): String? = runCatching {
        val r = api.rpc("media_url_by_path", JsonObject(mapOf("p_path" to JsonPrimitive(path))))
        r.jsonPrimitive.contentOrNull
    }.getOrNull()
}
