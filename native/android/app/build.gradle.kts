plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

android {
    namespace = "io.liuyiming.chat"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.liuyiming.chat"
        // Web 版没有版本门槛，原生版从 1 开始，避免与旧 APK 的 versionCode 冲突
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0-native"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    /* ⚠ AppDatabase 写了 exportSchema = true，但不给目录就只能在
       构建时告警 "Schema export directory was not provided"。
       导出的 schema 是**将来写迁移的依据**：没有它，哪天改表结构
       只能靠 fallbackToDestructiveMigration —— 那会清掉用户全部本地数据。 */
    ksp { arg("room.schemaLocation", "$projectDir/schemas") }
    buildFeatures { compose = true }
    /* ⚠ 删掉了 composeOptions { kotlinCompilerExtensionVersion = "1.5.15" }。
       那是 Kotlin **1.x** 时代的写法；2.0 起由 compose 插件自动管理编译器版本，
       同时保留这个旧写法会与新插件冲突（BUILD-COMPOSE-PLUGIN）。 */
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.navigation:navigation-compose:2.8.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")

    // 本地持久化：Room 取代 localStorage
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // 网络：OkHttp。不用 Retrofit —— 只有 39 个 RPC，一层手写封装反而更好控
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Markdown 渲染。Web 版有 chat/js/markdown.js，原生端需要等价物，
    // 否则消息里的 **粗体**、`代码` 会原样露出来 —— 那是明显的功能倒退。
    implementation("io.noties.markwon:core:4.6.2")

    debugImplementation("androidx.compose.ui:ui-tooling")

    /* ⚠ NATIVE-TEST：只加 junit，不加 Robolectric、不加模拟器。
       被测的 Rules / I18n / Strings **刻意不 import 任何 android.* 包** ——
       所以这些用例在纯 JVM 上就能跑，CI 里几秒钟出结果。

       不加 Robolectric 是刻意的：它要下载 android-all 的 jar（几百 MB），
       在 CI 上慢且容易因网络失败。而"能编译"长期是本项目的唯一验证手段，
       现在要补的是**规则被验证过**，不是补 UI 测试。
       真机行为另有验证清单（见 docs/原生端真机验证清单.md）。 */
    testImplementation("junit:junit:4.13.2")
    /* ⚠ NATIVE-TEST：被测的 Payload 要解析 JsonElement，而主代码里
       kotlinx-serialization-json 是 implementation，**不会**传递到测试 classpath。
       不加这一行，PayloadTest 会报 "Unresolved reference: kotlinx"，
       而且是编译期失败 —— 整个 test 任务挂掉，连 RulesTest 也一起跑不了。 */
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
}
