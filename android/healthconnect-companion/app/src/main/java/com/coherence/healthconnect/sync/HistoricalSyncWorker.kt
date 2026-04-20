package com.coherence.healthconnect.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.workDataOf
import androidx.work.WorkerParameters
import com.coherence.healthconnect.CoherenceApplication
import com.coherence.healthconnect.sdk.HealthConnectPayloadSource
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

    /**
     * Key under which the worker publishes a human-readable failure
     * reason on [androidx.work.Data] when a run ends in
     * [androidx.work.ListenableWorker.Result.failure]. Observed by
     * `SettingsScreen` to render the reason next to the button.
     */
    const val KEY_FAILURE_REASON = "failure_reason"

    const val DEFAULT_DAYS_BACK = 30
    const val MAX_DAYS_BACK = 30

    /** How many days to pack into a single batch POST. */
    private const val BATCH_CHUNK_DAYS = 7

    private const val CHANNEL_ID = "coherence_health_backfill"
    private const val NOTIFICATION_ID = 9002
    private const val TAG = "HealthBackfill"
  }

  private val repository: HealthConnectPayloadSource
    get() = (applicationContext as CoherenceApplication).container.healthConnectRepository
  private val cooldown
    get() = (applicationContext as CoherenceApplication).container.healthConnectCooldown
  private val webhookClient = WebhookClient()

  override suspend fun doWork(): Result {
    val daysBack = inputData
      .getInt(KEY_DAYS_BACK, DEFAULT_DAYS_BACK)
      .coerceIn(1, MAX_DAYS_BACK)

    return try {
      // Cooldown short-circuit. Surfacing the cooldown deadline as a
      // failure reason is more useful than silently succeeding because
      // the user explicitly clicked "Start backfill" and expects
      // either data or an explanation.
      val cooldownState = cooldown.getState()
      if (cooldownState.active) {
        val message = "Health Connect rate limit cooldown active until " +
          "${cooldownState.until}. Try again later — automatic syncs will " +
          "resume on their own once the quota replenishes."
        Log.w(TAG, message)
        return Result.failure(workDataOf(KEY_FAILURE_REASON to message))
      }

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
            return Result.failure(
              workDataOf(
                KEY_FAILURE_REASON to "Server rejected backfill (HTTP ${response.statusCode}): " +
                  response.message.take(200),
              ),
            )
          }
        }
      }

      if (hasRetryable) {
        Result.retry()
      } else {
        // If the mapper surfaced rate-limit warnings on the payloads
        // themselves, promote the first one into the WorkInfo output
        // so the UI can show it even though the worker returned
        // success (data archived, just with gaps).
        val rateLimitWarning = payloads.asSequence()
          .flatMap { it.sync.warnings.asSequence() }
          .firstOrNull { it.contains("rate limit", ignoreCase = true) || it.contains("quota", ignoreCase = true) }
        if (rateLimitWarning != null) {
          Log.w(TAG, "Backfill completed with rate-limit warnings: $rateLimitWarning")
          Result.success(
            workDataOf(KEY_FAILURE_REASON to "Partial: $rateLimitWarning"),
          )
        } else {
          Result.success()
        }
      }
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
