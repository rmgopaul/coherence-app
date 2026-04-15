package com.coherence.samsunghealth.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.coherence.samsunghealth.CoherenceApplication
import com.coherence.samsunghealth.sdk.SamsungHealthRepository

/**
 * Periodic and one-shot "sync now" worker. Fetches *today's* payload
 * from the [SamsungHealthRepository] and posts it to the single-day
 * webhook with classified retry semantics:
 *
 *  - [WebhookResult.Success]   → [Result.success]
 *  - [WebhookResult.Retryable] → [Result.retry]  (network glitch, 5xx)
 *  - [WebhookResult.Permanent] → [Result.failure] (401 bad key, 400 payload)
 *
 * The old worker caught every throwable and retried forever. The new
 * worker distinguishes transient failures from permanent ones so bad
 * configuration surfaces instead of silently burning battery.
 */
class SamsungHealthSyncWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {

  companion object {
    const val ONE_TIME_SYNC_NAME = "samsung-health-sync-now"
    const val PERIODIC_SYNC_NAME = "samsung-health-sync-periodic"
    private const val CHANNEL_ID = "coherence_health_sync"
    private const val NOTIFICATION_ID = 9001
    private const val TAG = "HealthSyncWorker"
  }

  private val repository: SamsungHealthRepository
    get() = (applicationContext as CoherenceApplication).container.samsungHealthRepository
  private val cooldown
    get() = (applicationContext as CoherenceApplication).container.healthConnectCooldown
  private val webhookClient = WebhookClient()

  override suspend fun doWork(): Result {
    return try {
      // Cooldown short-circuit: if a previous run already burned
      // through the rate-limit budget, sit out this period rather
      // than firing 22 more reads at an exhausted quota.
      val cooldownState = cooldown.getState()
      if (cooldownState.active) {
        Log.i(
          TAG,
          "Skipping periodic sync — Health Connect rate-limit cooldown until ${cooldownState.until}",
        )
        return Result.success()
      }

      setForeground(createForegroundInfo())
      val payload = repository.collectDailyPayload()

      when (val response = webhookClient.postSamsungHealth(payload)) {
        is WebhookResult.Success -> {
          Log.i(TAG, "Sync succeeded: HTTP ${response.statusCode}")
          Result.success()
        }
        is WebhookResult.Retryable -> {
          Log.w(
            TAG,
            "Sync retryable failure (HTTP ${response.statusCode}): ${response.message}",
          )
          Result.retry()
        }
        is WebhookResult.Permanent -> {
          Log.e(
            TAG,
            "Sync permanent failure (HTTP ${response.statusCode}): ${response.message}",
          )
          Result.failure()
        }
      }
    } catch (error: Throwable) {
      Log.e(TAG, "Sync threw unexpectedly", error)
      // Unknown-shape throwables are retried once; WorkManager's
      // backoff policy bounds the retry frequency.
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
