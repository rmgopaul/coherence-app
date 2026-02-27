package com.coherence.samsunghealth.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

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
    WorkManager.getInstance(context).cancelUniqueWork(SamsungHealthSyncWorker.PERIODIC_SYNC_NAME)
    WorkManager.getInstance(context).cancelUniqueWork(SamsungHealthSyncWorker.ONE_TIME_SYNC_NAME)
  }

  fun isEnabled(context: Context): Boolean {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    return prefs.getBoolean(KEY_AUTO_SYNC_ENABLED, false)
  }

  fun ensureScheduledIfEnabled(context: Context) {
    if (!isEnabled(context)) return
    schedulePeriodic(context)
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
      TimeUnit.MINUTES
    )
      .setConstraints(constraints)
      .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.MINUTES)
      .build()

    WorkManager.getInstance(context).enqueueUniquePeriodicWork(
      SamsungHealthSyncWorker.PERIODIC_SYNC_NAME,
      ExistingPeriodicWorkPolicy.UPDATE,
      periodicWork
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
      nowWork
    )
  }
}
