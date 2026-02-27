package com.coherence.samsunghealth.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.coherence.samsunghealth.sdk.SamsungHealthDataSdkRepository

class SamsungHealthSyncWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {

  companion object {
    const val ONE_TIME_SYNC_NAME = "samsung-health-sync-now"
    const val PERIODIC_SYNC_NAME = "samsung-health-sync-periodic"
  }

  private val repository = SamsungHealthDataSdkRepository(appContext)
  private val webhookClient = WebhookClient()

  override suspend fun doWork(): Result {
    return try {
      val payload = repository.collectDailyPayload()
      val response = webhookClient.postSamsungHealth(payload)
      if (response.success) Result.success() else Result.retry()
    } catch (_: Throwable) {
      Result.retry()
    }
  }
}
