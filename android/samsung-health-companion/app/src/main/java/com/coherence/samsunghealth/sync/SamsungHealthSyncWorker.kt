package com.coherence.samsunghealth.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.coherence.samsunghealth.sdk.SamsungHealthDataSdkRepository

class SamsungHealthSyncWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {

  companion object {
    const val ONE_TIME_SYNC_NAME = "samsung-health-sync-now"
    const val PERIODIC_SYNC_NAME = "samsung-health-sync-periodic"
    private const val CHANNEL_ID = "coherence_health_sync"
    private const val NOTIFICATION_ID = 9001
  }

  private val repository = SamsungHealthDataSdkRepository(appContext)
  private val webhookClient = WebhookClient()

  override suspend fun doWork(): Result {
    return try {
      setForeground(createForegroundInfo())
      val payload = repository.collectDailyPayload()
      val response = webhookClient.postSamsungHealth(payload)
      if (response.success) Result.success() else Result.retry()
    } catch (_: Throwable) {
      Result.retry()
    }
  }

  override suspend fun getForegroundInfo(): ForegroundInfo {
    return createForegroundInfo()
  }

  private fun createForegroundInfo(): ForegroundInfo {
    val context = applicationContext

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Health Sync",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Background health data sync"
      }
      val manager = context.getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(channel)
    }

    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setContentTitle("Syncing health data")
      .setSmallIcon(android.R.drawable.ic_popup_sync)
      .setOngoing(true)
      .setSilent(true)
      .build()

    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      ForegroundInfo(
        NOTIFICATION_ID,
        notification,
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH,
      )
    } else {
      ForegroundInfo(NOTIFICATION_ID, notification)
    }
  }
}
