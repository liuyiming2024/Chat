plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    /* ⚠ Kotlin 2.0 起 Compose 编译器拆成独立插件（BUILD-COMPOSE-PLUGIN）。
       不加这个插件，配置阶段就报错：
         "Starting in Kotlin 2.0, the Compose Compiler Gradle plugin is required"
       而且它是**配置期**失败，一行代码都没编译 —— CI 上只看到"构建失败"，
       看不出是缺插件。版本必须与 kotlin.android **完全一致**（这里是 2.0.21），
       不一致会报版本不匹配。 */
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("com.google.devtools.ksp") version "2.0.21-1.0.27" apply false
}
