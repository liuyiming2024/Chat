plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
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
    buildFeatures { compose = true }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.15" }
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
}
