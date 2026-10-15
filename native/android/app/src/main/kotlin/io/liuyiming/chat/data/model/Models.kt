package io.liuyiming.chat.data.model

import kotlinx.serialization.Serializable

/**
 * 数据模型。字段口径必须与服务端 schema.sql **逐一对齐** ——
 * 原生端和 Web 端读的是同一份服务端，名字对不上就是一个静默的坏功能：
 * 不报错，只是那一列永远是空的。
 */

@Serializable
data class User(
    val id: String,
    val nick: String,
    val role: String = "member",
    val real: String? = null,
    val active: Boolean = true,
    val mutedUntil: Long? = null,
    val createdAt: Long = 0
)

@Serializable
data class Room(
    val id: String,
    val name: String,
    val owner: String? = null,
    val admins: List<String> = emptyList(),
    val muted: List<String> = emptyList(),
    val createdAt: Long = 0
)

@Serializable
data class Message(
    val id: String,
    val room: String,
    val from: String,
    val kind: String = "text",
    val body: String = "",
    val media: String? = null,
    val at: Long = 0,
    val editedAt: Long? = null,
    val deleted: Boolean = false,
    val rev: Long = 0
)

@Serializable
data class PendingMessage(
    val localId: String,
    val room: String,
    val kind: String,
    val body: String,
    val mediaPath: String?,
    val createdAt: Long
)
