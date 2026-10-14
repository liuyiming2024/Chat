package io.liuyiming.chat.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.lifecycle.lifecycleScope
import io.liuyiming.chat.ChatApp
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as ChatApp
        setContent { ChatTheme { Root(app) } }

        // 前后台切换要告诉同步引擎：后台降频，省电也省免费额度
        lifecycleScope.launch { app.sync.foreground = true }
    }

    override fun onStop() {
        (application as ChatApp).sync.foreground = false
        super.onStop()
    }
}

@Composable
fun ChatTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = lightColorScheme(), content = content)
}
