package kr.wolgyeon.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** 휴대폰 알림 띄우기 (채널: 행사 알림 / 행사 추천 / 공지) */
object Notifier {
    const val CH_EVENT = "events"
    const val CH_PROMO = "promo"
    const val CH_NOTICE = "notice"

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_EVENT, "행사 알림", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "즐겨찾기한 행사가 곧 시작할 때, 새 행사가 올라왔을 때"
        })
        nm.createNotificationChannel(NotificationChannel(CH_PROMO, "근처 행사 추천", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "가까운 날 월계동에서 열리는 행사 소개 (하루 한 번)"
        })
        nm.createNotificationChannel(NotificationChannel(CH_NOTICE, "월계온 공지", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "운영진이 보내는 알림"
        })
    }

    fun permitted(ctx: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(ctx).areNotificationsEnabled()

    /** link: "#/event/12" 처럼 앱 안 화면 주소 — 알림을 누르면 그 화면이 열림 */
    fun show(ctx: Context, id: Int, channel: String, title: String, body: String, link: String) {
        if (!permitted(ctx)) return
        ensureChannels(ctx)
        val open = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_LINK, link)
        }
        val pi = PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setColor(0xFFEE3F5B.toInt())
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(if (channel == CH_EVENT) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .build()
        try {
            NotificationManagerCompat.from(ctx).notify(id, n)
        } catch (_: SecurityException) { }
    }
}
