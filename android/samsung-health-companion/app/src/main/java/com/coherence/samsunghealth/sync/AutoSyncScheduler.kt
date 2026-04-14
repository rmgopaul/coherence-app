package com.coherence.samsunghealth.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * WorkManager scheduling helpers for the three sync lifecycles:
 *  - Periodic daily sync ([SamsungHealthSyncWorker.PERIODIC_SYNC_NAME])
 *  - One-shot "sync now" ([SamsungHealthSyncWorker.ONE_TIME_SYNC_NAME])
 *  - One-shot historical backfill ([HistoricalSyncWorker.WORK_NAME])
 */
object AutoSyncScheduler {
  private const val PREFS_NAME = "coherence_samsung_sync_prefs"
  private const val KEY_AUTO_SYNC_ENABLED = "auto_sync_enabled"

  fun enable(context: Context) {
    setEnabled(context, true)
    schedulePeriodic(context)
    scheduleImmediate(context)
  }

  fun disable(context: Context) {
    setEnabled(context, false)
    val workManager = WorkManager.getInstance(context)
    workManager.cancelUniqueWork(SamsungHealthSyncWorker.PERIODIC_SYNC_NAME)
    workManager.cancelUniqueWork(SamsungHealthSyncWorker.ONE_TIME_SYNC_NAME)
    workManager.cancelUniqueWork(HistoricalSyncWorker.WORK_NAME)
  }

  fun isEnabled(context: Context): Boolean {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    return prefs.getBoolean(KEY_AUTO_SYNC_ENABLED, false)
  }

  fun ensureScheduledIfEnabled(context: Context) {
    if (!isEnabled(context)) return
    schedulePeriodic(context)
  }

  /**
   * Enqueue a one-shot historical backfill for the last [daysBack]
   * days (clamped to Health Connect's retention window). If a
   * backfill is already running, this call replaces it.
   */
  fun scheduleHistoricalBackfill(
    context: Context,
    daysBack: Int = HistoricalSyncWorker.DEFAULT_DAYS_BACK,
  ) {
    val safeDays = daysBack.coerceIn(1, HistoricalSyncWorker.MAX_DAYS_BACK)
    val constraints = Constraints.Builder()
      .setRequiredNetworkType(NetworkType.CONNECTED)
      .build()

    val input = Data.Builder()
      .putInt(HistoricalSyncWorker.KEY_DAYS_BACK, safeDays)
      .build()

    val work = OneTimeWorkRequestBuilder<HistoricalSyncWorker>()
      .setConstraints(constraints)
      .setInputData(input)
      .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.MINUTES)
      .build()

    WorkManager.getInstance(context).enqueueUniqueWork(
      HistoricalSyncWorker.WORK_NAME,
      ExistingWorkPolicy.REPLACE,
      work,
    )
  }

  private fun setEnabled(context: Context, enabled: Boolean) {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    prefs.edit().putBoolean(KEY_AUTO_SYNC_ENABLED, enabled).apply()
  }

  private fun schedulePeriodic(context: Context) {
    val constraints = Constraints.Builder()
      .setRequiredNetworkType(NetworkType.CONNECTED)
      .build()

    val periodicWork = PeriodicWorkRequestBuilder<SamsungHealthSyncWorker>(
      15,
      TimeUnit.MINUTES,
      5,
      TimeUnit.MINUTES,
    )
      .setConstraints(constraints)
      .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.MINUTES)
      .build()

    WorkManager.getInstance(context).enqueueUniquePeriodicWork(
      SamsungHealthSyncWorker.PERIODIC_SYNC_NAME,
      ExistingPeriodicWorkPolicy.UPDATE,
      periodicWork,
    )
  }

  private fun scheduleImmediate(context: Context) {
    val constraints = Constraints.Builder()
      .setRequiredNetworkType(NetworkType.CONNECTED)
      .build()

    val nowWork = OneTimeWorkRequestBuilder<SamsungHealthSyncWorker>()
      .setConstraints(constraints)
      .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.MINUTES)
      .build()

    WorkManager.getInstance(context).enqueueUniqueWork(
      SamsungHealthSyncWorker.ONE_TIME_SYNC_NAME,
      ExistingWorkPolicy.REPLACE,
      nowWork,
    )
  }
}
