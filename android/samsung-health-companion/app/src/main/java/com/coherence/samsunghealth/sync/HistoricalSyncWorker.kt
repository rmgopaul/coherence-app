package com.coherence.samsunghealth.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.coherence.samsunghealth.CoherenceApplication
import com.coherence.samsunghealth.sdk.SamsungHealthRepository
import java.time.LocalDate
import java.time.ZoneId

/**
 * One-shot worker that backfills historical Health Connect data by
 * collecting a payload for every day in a given range and posting
 * them to the batch webhook endpoint in chunks.
 *
 * Input parameters (via [Data]):
 *  - [KEY_DAYS_BACK] — number of trailing days to pull (default 30)
 *
 * Health Connect retains most non-medical records for up to 30 days,
 * so this is the sensible default ceiling for a backfill.
 */
class HistoricalSyncWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {

  companion object {
    const val WORK_NAME = "samsung-health-historical-sync"
    const val KEY_DAYS_BACK = "days_back"
    const val DEFAULT_DAYS_BACK = 30
    const val MAX_DAYS_BACK = 30

    /** How many days to pack into a single batch POST. */
    private const val BATCH_CHUNK_DAYS = 7

    private const val CHANNEL_ID = "coherence_health_backfill"
    private const val NOTIFICATION_ID = 9002
    private const val TAG = "HealthBackfill"
  }

  private val repository: SamsungHealthRepository
    get() = (applicationContext as CoherenceApplication).container.samsungHealthRepository
  private val webhookClient = WebhookClient()

  override suspend fun doWork(): Result {
    val daysBack = inputData
      .getInt(KEY_DAYS_BACK, DEFAULT_DAYS_BACK)
      .coerceIn(1, MAX_DAYS_BACK)

    return try {
      setForeground(createForegroundInfo(daysBack))

      val zone = ZoneId.systemDefault()
      val today = LocalDate.now(zone)
      // End of range is *yesterday* — today is owned by the regular
      // periodic sync and including it here would cause duplicate
      // writes on the same calendar day.
      val endDate = today.minusDays(1)
      val startDate = endDate.minusDays((daysBack - 1).toLong())
      if (endDate.isBefore(startDate)) {
        Log.i(TAG, "Nothing to backfill (endDate $endDate before startDate $startDate)")
        return Result.success()
      }

      Log.i(TAG, "Backfilling $startDate..$endDate ($daysBack days)")
      val payloads = repository.collectPayloadRange(startDate, endDate)
      Log.i(TAG, "Collected ${payloads.size} historical payloads")

      // Chunk into 7-day batches so a single POST never carries more
      // than a week's worth of high-frequency samples.
      val chunks = payloads.chunked(BATCH_CHUNK_DAYS)
      var hasRetryable = false
      for ((index, chunk) in chunks.withIndex()) {
        when (val response = webhookClient.postSamsungHealthBatch(chunk)) {
          is WebhookResult.Success -> {
            Log.i(
              TAG,
              "Chunk ${index + 1}/${chunks.size} posted (HTTP ${response.statusCode})",
            )
          }
          is WebhookResult.Retryable -> {
            Log.w(
              TAG,
              "Chunk ${index + 1}/${chunks.size} retryable (HTTP ${response.statusCode}): ${response.message}",
            )
            hasRetryable = true
            // Stop early — WorkManager will re-run the whole job and
            // the server-side upsert makes replay idempotent per day.
            break
          }
          is WebhookResult.Permanent -> {
            Log.e(
              TAG,
              "Chunk ${index + 1}/${chunks.size} permanent (HTTP ${response.statusCode}): ${response.message}",
            )
            return Result.failure()
          }
        }
      }

      if (hasRetryable) Result.retry() else Result.success()
    } catch (error: Throwable) {
      Log.e(TAG, "Historical sync threw", error)
      Result.retry()
    }
  }

  override suspend fun getForegroundInfo(): ForegroundInfo {
    val daysBack = inputData.getInt(KEY_DAYS_BACK, DEFAULT_DAYS_BACK).coerceIn(1, MAX_DAYS_BACK)
    return createForegroundInfo(daysBack)
  }

  private fun createForegroundInfo(daysBack: Int): ForegroundInfo {
    val context = applicationContext

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Health Backfill",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Backfilling historical health data"
      }
      val manager = context.getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(channel)
    }

    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setContentTitle("Backfilling $daysBack days of health data")
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
