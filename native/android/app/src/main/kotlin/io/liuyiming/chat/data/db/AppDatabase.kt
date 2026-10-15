package io.liuyiming.chat.data.db

import androidx.room.*
import kotlinx.serialization.json.Json

/**
 * 类型转换：Room 不认 List<String>，存成 JSON 数组字符串。
 *
 * ⚠ 这里用 Json.parseToJsonElement 而不是直接 split(",") ——
 * 昵称里出现逗号时 split 会把一条拆成两条，
 * 表现为"这个房间莫名多出一个不存在的成员"，极难定位。
 */
class Converters {
    private val json = Json { ignoreUnknownKeys = true }

    @TypeConverter
    fun fromList(v: List<String>): String =
        json.encodeToString(kotlinx.serialization.builtins.ListSerializer(kotlinx.serialization.serializer<String>()), v)

    @TypeConverter
    fun toList(v: String): List<String> = runCatching {
        json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(kotlinx.serialization.serializer<String>()), v)
    }.getOrDefault(emptyList())
}

@Dao
interface MessageDao {
    @Query("SELECT * FROM messages WHERE room = :room AND deleted = 0 ORDER BY at ASC")
    suspend fun list(room: String): List<MessageEntity>

    @Upsert
    suspend fun upsertAll(items: List<MessageEntity>)

    @Query("DELETE FROM messages WHERE room = :room")
    suspend fun clearRoom(room: String)
}

@Dao
interface RoomDao {
    @Query("SELECT * FROM rooms ORDER BY createdAt ASC")
    suspend fun all(): List<RoomEntity>

    @Upsert
    suspend fun upsertAll(items: List<RoomEntity>)
}

@Dao
interface UserDao {
    @Query("SELECT * FROM users")
    suspend fun all(): List<UserEntity>

    @Upsert
    suspend fun upsertAll(items: List<UserEntity>)
}

/** 离线待发队列。补发成功才删，绝不"发出去就删"。 */
@Dao
interface PendingDao {
    @Query("SELECT * FROM pending ORDER BY createdAt ASC")
    suspend fun all(): List<PendingEntity>

    @Insert
    suspend fun add(item: PendingEntity)

    @Query("DELETE FROM pending WHERE localId = :id")
    suspend fun remove(id: String)
}

@Dao
interface SyncDao {
    @Query("SELECT rev FROM sync_state WHERE id = 0")
    suspend fun rev(): Long?

    @Upsert
    suspend fun save(s: SyncStateEntity)
}

@Database(
    entities = [MessageEntity::class, RoomEntity::class, UserEntity::class, PendingEntity::class, SyncStateEntity::class],
    version = 1,
    exportSchema = true
)
@TypeConverters(Converters::class)
abstract class AppDatabase : RoomDatabase() {
    abstract fun messages(): MessageDao
    abstract fun rooms(): RoomDao
    abstract fun users(): UserDao
    abstract fun pending(): PendingDao
    abstract fun sync(): SyncDao
}
