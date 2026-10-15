package io.liuyiming.chat.data.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * 本地持久化。对应 Web 版的 localStorage + IndexedDB。
 *
 * 为什么要换掉：localStorage 在移动端本就不该是归宿 ——
 * 容量小、进程被杀可能丢、也不参与系统备份。SQLite 才是原生应用该用的。（NATIVE-ARCH）
 */

@Entity(tableName = "messages", indices = [Index("room"), Index("rev")])
data class MessageEntity(
    @PrimaryKey val id: String,
    val room: String,
    val from: String,
    val kind: String,
    val body: String,
    val media: String?,
    val at: Long,
    val editedAt: Long?,
    val deleted: Boolean,
    val rev: Long
)

@Entity(tableName = "rooms")
data class RoomEntity(
    @PrimaryKey val id: String,
    val name: String,
    val owner: String?,
    val admins: String,      // JSON 数组字符串。Room 不直接支持 List<String>
    val muted: String,
    val createdAt: Long
)

@Entity(tableName = "users")
data class UserEntity(
    @PrimaryKey val id: String,
    val nick: String,
    val role: String,
    val real: String?,
    val active: Boolean,
    val mutedUntil: Long?,
    val createdAt: Long
)

@Entity(tableName = "pending")
data class PendingEntity(
    @PrimaryKey val localId: String,
    val room: String,
    val kind: String,
    val body: String,
    val mediaPath: String?,
    val createdAt: Long
)

/**
 * 同步水位单独建表。
 * Web 版把它塞在状态的 seq 字段里 —— 水位和业务数据混在一起，
 * 清数据时会被一起清掉，下次启动全量重拉，白花流量。
 */
@Entity(tableName = "sync_state")
data class SyncStateEntity(
    @PrimaryKey val id: Int = 0,
    val rev: Long
)
