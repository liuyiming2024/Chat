package io.liuyiming.chat

import android.app.Application
import androidx.room.Room
import io.liuyiming.chat.api.ApiClient
import io.liuyiming.chat.api.Config
import io.liuyiming.chat.data.ChatRepository
import io.liuyiming.chat.data.db.AppDatabase
import io.liuyiming.chat.sync.SyncEngine

/**
 * 真原生入口。
 *
 * 与 Web 版的根本差别：这里**没有任何 WebView**，
 * 界面全部由 Compose 绘制，数据落在 SQLite。
 * 不再存在"把 www/ 塞进壳里"这回事。
 */
class ChatApp : Application() {
    lateinit var api: ApiClient
        private set
    lateinit var db: AppDatabase
        private set
    lateinit var repo: ChatRepository
        private set
    lateinit var sync: SyncEngine
        private set

    override fun onCreate() {
        super.onCreate()
        api = ApiClient(Config.DEFAULT_URL, Config.DEFAULT_KEY)
        db = Room.databaseBuilder(this, AppDatabase::class.java, "chat.db")
            // 迁移失败就重建，比崩溃好；但正式版要写迁移，不能一直靠这个
            .fallbackToDestructiveMigration()
            .build()
        repo = ChatRepository(api, db)
        sync = SyncEngine(api, db)
        sync.start()
    }
}
