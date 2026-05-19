package com.coherence.samsunghealth.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Periodic background sync. Reads the two Samsung scores and POSTs
 * them to the webhook. Retryable webhook failures map to
 * [Result.retry] so WorkManager backs off and retries; permanent
 * failures (bad sync key) map to [Result.failure] so we don't spin.
 */
class SamsungSyncWorker(
  appContext: Context,
  params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

  override suspend fun doWork(): Result {
    if (!SyncConfig.isConfigured()) {
      // Nothing we can do until the developer populates the sync
      // key — don't retry forever.
      return Result.failure()
    }
    return when (SamsungSyncManager(applicationContext).syncToday()) {
      is WebhookResult.Success -> Result.success()
      is WebhookResult.Retryable -> Result.retry()
      is WebhookResult.Permanent -> Result.failure()
    }
  }

  companion object {
    private const val UNIQUE_WORK = "samsung-health-periodic-sync"

    /**
     * Schedules the periodic sync if not already scheduled. 3-hour
     * cadence — Samsung Sleep/Energy scores update at most once per
     * day, so this is well within any sane quota even accounting
     * for WorkManager's minimum 15-min flex.
     */
    fun ensureScheduled(context: Context) {
      val request = PeriodicWorkRequestBuilder<SamsungSyncWorker>(
        3, TimeUnit.HOURS,
      )
        .setConstraints(
          Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build(),
        )
        .build()

      WorkManager.getInstance(context).enqueueUniquePeriodicWork(
        UNIQUE_WORK,
        ExistingPeriodicWorkPolicy.KEEP,
        request,
      )
    }
  }
}
