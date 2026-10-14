package io.liuyiming.chat.core

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * 系统通知。这是套壳端做不好、原生端本该做好的地方。
 *
 * ⚠ Android 13+ 需要 POST_NOTIFICATIONS 权限。（NATIVE-MSG）
 * 没权限就**静默不发**，不要弹系统设置页骚扰用户 ——
 * 他如果拒过一次，再弹就是骚扰。
 */
object Notify {
    private const val CH = "chat_msg"

    fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CH) != null) return
        mgr.createNotificationChannel(
            NotificationChannel(CH, "新消息", NotificationManager.IMPORTANCE_DEFAULT)
        )
    }

    fun granted(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    fun show(ctx: Context, title: String, text: String) {
        ensureChannel(ctx)
        if (!granted(ctx)) return
        val n = NotificationCompat.Builder(ctx, CH)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java)
            ?.notify(System.currentTimeMillis().toInt(), n)
    }
}
