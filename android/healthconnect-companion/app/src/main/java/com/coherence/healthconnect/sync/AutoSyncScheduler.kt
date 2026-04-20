package com.coherence.healthconnect.sync

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
 *  - Periodic daily sync ([HealthConnectPeriodicSyncWorker.PERIODIC_SYNC_NAME])
 *  - One-shot "sync now" ([HealthConnectPeriodicSyncWorker.ONE_TIME_SYNC_NAME])
 *  - One-shot historical backfill ([HistoricalSyncWorker.WORK_NAME])
 */
object AutoSyncScheduler {
  private const val PREFS_NAME = "coherence_samsung_sync_prefs"
  private const val KEY_AUTO_SYNC_ENABLED = "auto_sync_enabled"
  private const val KEY_LAST_MANUAL_TRIGGER_MS = "last_manual_trigger_ms"

  /**
   * How long to wait before allowing another app-resume-triggered
   * sync. Protects against tab swipes + app re-entry hammering the
   * sync worker whenever the user bounces around the app.
   */
  private const val RESUME_DEBOUNCE_MS = 5L * 60L * 1000L // 5 min

  /**
   * Periodic sync cadence. Health Connect's per-app rate limit is a
   * rolling 24h window at ~2000 reads/day for foreground and lower
   * for background. Each sync issues 22 typed reads, so 15-min
   * cadence = 2112 reads/day = guaranteed saturation. 60-min cadence
   * = 528 reads/day = comfortable headroom that leaves room for
   * backfills and other HC consumers (Google Fit, third-party apps).
   */
  private const val PERIODIC_INTERVAL_MINUTES = 60L
  private const val PERIODIC_FLEX_MINUTES = 15L

  fun enable(context: Context) {
    setEnabled(context, true)
    schedulePeriodic(context)
    scheduleImmediate(context)
  }

  fun disable(context: Context) {
    setEnabled(context, false)
    val workManager = WorkManager.getInstance(context)
    workManager.cancelUniqueWork(HealthConnectPeriodicSyncWorker.PERIODIC_SYNC_NAME)
    workManager.cancelUniqueWork(HealthConnectPeriodicSyncWorker.ONE_TIME_SYNC_NAME)
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
   * Public "user just asked for a sync" entry point. Used by:
   *  - `MainActivity.onResume` (debounced — won't fire more than
   *    once per [RESUME_DEBOUNCE_MS]).
   *  - The dashboard "Sync Now" button (bypasses the debounce by
   *    passing `force = true`).
   *
   * Respects the cooldown via the worker itself — this function just
   * enqueues; the worker decides whether to actually hit HC.
   */
  fun triggerManualSync(context: Context, force: Boolean = false) {
    if (!isEnabled(context)) return
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val now = System.currentTimeMillis()
    if (!force) {
      val last = prefs.getLong(KEY_LAST_MANUAL_TRIGGER_MS, 0L)
      if (now - last < RESUME_DEBOUNCE_MS) return
    }
    prefs.edit().putLong(KEY_LAST_MANUAL_TRIGGER_MS, now).apply()
    scheduleImmediate(context)
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

    val periodicWork = PeriodicWorkRequestBuilder<HealthConnectPeriodicSyncWorker>(
      PERIODIC_INTERVAL_MINUTES,
      TimeUnit.MINUTES,
      PERIODIC_FLEX_MINUTES,
      TimeUnit.MINUTES,
    )
      .setConstraints(constraints)
      .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.MINUTES)
      .build()

    WorkManager.getInstance(context).enqueueUniquePeriodicWork(
      HealthConnectPeriodicSyncWorker.PERIODIC_SYNC_NAME,
      ExistingPeriodicWorkPolicy.UPDATE,
      periodicWork,
    )
  }

  private fun scheduleImmediate(context: Context) {
    val constraints = Constraints.Builder()
      .setRequiredNetworkType(NetworkType.CONNECTED)
      .build()

    val nowWork = OneTimeWorkRequestBuilder<HealthConnectPeriodicSyncWorker>()
      .setConstraints(constraints)
      .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.MINUTES)
      .build()

    WorkManager.getInstance(context).enqueueUniqueWork(
      HealthConnectPeriodicSyncWorker.ONE_TIME_SYNC_NAME,
      ExistingWorkPolicy.REPLACE,
      nowWork,
    )
  }
}
