package io.liuyiming.chat.core

import android.content.Context
import java.io.File
import java.security.MessageDigest

/**
 * 本地媒体缓存。对应 Web 版的 IndexedDB。
 *
 * ⚠ 放在 `filesDir/media`，**不能放 cacheDir**。（NATIVE-MEDIA）
 * cacheDir 在系统存储紧张时会被清掉 —— 那正是"上传还没完成"的时候，
 * 于是用户以为发出去的图，重启后没了，而消息气泡还在。
 * 发完的媒体是内容不是缓存，必须跟应用数据一起留存。
 *
 * ⚠ 命名用内容哈希：同一张图反复发送不会存多份，
 * 否则连发几次就能把用户存储吃光（Web 版踩过头像缓存无限增长这条）。
 */
object MediaStore {
    fun dir(ctx: Context): File = File(ctx.filesDir, "media").apply { mkdirs() }

    fun put(ctx: Context, bytes: ByteArray, ext: String): File {
        val name = MessageDigest.getInstance("SHA-256")
            .digest(bytes).joinToString("") { "%02x".format(it) }.take(32) + ".$ext"
        val f = File(dir(ctx), name)
        if (!f.exists()) f.writeBytes(bytes)
        return f
    }

    fun get(ctx: Context, name: String): File? = File(dir(ctx), name).takeIf { it.exists() }

    /** 缓存总量。设置页要显示，让用户知道占了多少。 */
    fun size(ctx: Context): Long = dir(ctx).walkTopDown().filter { it.isFile }.map { it.length() }.sum()
}
