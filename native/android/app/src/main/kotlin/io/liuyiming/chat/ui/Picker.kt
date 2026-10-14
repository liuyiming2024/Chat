package io.liuyiming.chat.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * 媒体选择。
 *
 * ⚠ 用系统的照片选择器（Photo Picker）而不是 READ_EXTERNAL_STORAGE 权限：
 * 后者要弹权限框，用户拒了就没得用；前者不需要任何权限，
 * 且是 Android 官方推荐做法。能用系统组件解决的，就不要申请权限。
 */
@Composable
fun rememberMediaPicker(onPicked: (Uri) -> Unit): () -> Unit {
    var launched by androidx.compose.runtime.remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri -> uri?.let { onPicked(it) } }
    return { if (!launched) { launched = true; launcher.launch("image/*") } }
}
