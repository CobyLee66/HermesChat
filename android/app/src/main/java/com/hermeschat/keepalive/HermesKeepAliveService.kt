package com.hermeschat.keepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * HermesKeepAliveService — 连接存续期间的前台保活服务（契约见 docs/ssh-module.md §7）。
 *
 * 背景：SSH 会话（JSch）与 WS 都活在 App 进程内，无前台服务时 Android 后台
 * Doze/App Standby 会挂起网络并最终杀进程，keepalive 超时即隧道断开。
 * 前台服务（dataSync 类型）+ partial wake lock 让进程与网络在灭屏后台继续
 * 存活，JSch 15s keepalive 正常收发。
 *
 * 生命周期约束：
 * - 必须在 App 前台时启动（Android 12+ 禁止后台启动 FGS）——JS 侧在 connect
 *   成功点启动，这是唯一合规时机；
 * - manifest 声明 stopWithTask="true"：划卡杀进程时 SSH 本就随进程死，服务
 *   一并停掉并走 onDestroy 释放 wake lock，不留孤儿通知；
 * - 常驻通知是 FGS 的强制代价（IMPORTANCE_LOW 低打扰，点击回 App）。
 */
class HermesKeepAliveService : Service() {

  companion object {
    const val CHANNEL_ID = "hermes.keepalive"
    const val NOTIFICATION_ID = 4101
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    private const val WAKELOCK_TAG = "hermes:ssh-keepalive"

    @Volatile private var wakeLock: PowerManager.WakeLock? = null

    fun startIntent(context: Context, title: String, body: String): Intent =
      Intent(context, HermesKeepAliveService::class.java)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_BODY, body)

    fun stopIntent(context: Context): Intent =
      Intent(context, HermesKeepAliveService::class.java)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // 重复 start（重连成功后再次调用）= 仅刷新通知文案，wake lock 幂等
    val title = intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() }
      ?: packageManager.getApplicationLabel(applicationInfo).toString()
    val body = intent?.getStringExtra(EXTRA_BODY) ?: ""
    ensureChannel()
    startForegroundCompat(NOTIFICATION_ID, buildNotification(title, body))
    acquireWakeLock()
    return START_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    super.onDestroy()
  }

  // ---------------------------------------------------------------------------

  private fun ensureChannel() {
    // NotificationChannel 系 API 26+；以下版本前台服务通知无需渠道
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ID) != null) {
      return
    }
    val channel = NotificationChannel(
      CHANNEL_ID,
      // 渠道名用户可见（系统通知设置里），用应用名即可，无需随界面语言
      packageManager.getApplicationLabel(applicationInfo),
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      setShowBadge(false)
    }
    nm.createNotificationChannel(channel)
  }

  private fun buildNotification(title: String, body: String): Notification {
    // 点击通知回 App（launch intent 由系统给出，singleTask 下复用现有任务）
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launch?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    // 小图标用应用图标；个别 ROM 上 adaptive icon 取不到时回退系统同步图标
    val icon = applicationInfo.icon.takeIf { it != 0 }
      ?: android.R.drawable.stat_notify_sync
    // 渠道构造器 API 26+；以下版本用单参构造器（渠道在 ensureChannel 已同版跳过）
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setSmallIcon(icon)
      .setContentTitle(title)
      .setContentText(body)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .apply { contentIntent?.let { setContentIntent(it) } }
      .build()
  }

  private fun startForegroundCompat(id: Int, notification: Notification) {
    // targetSdk 34+ 必须走带类型的重载，且 manifest 已声明对应权限
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(id, notification)
    }
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) {
      return
    }
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  private fun releaseWakeLock() {
    try {
      wakeLock?.takeIf { it.isHeld }?.release()
    } catch (_: Throwable) {
      // 忽略（重复释放防御）
    }
    wakeLock = null
  }
}
