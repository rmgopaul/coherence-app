package com.coherence.samsunghealth.sync

import android.content.Context
import android.util.Log
import com.coherence.samsunghealth.sdk.SamsungHealthReader

/**
 * Thin orchestrator: read the two scores via [SamsungHealthReader],
 * POST the assembled payload via [WebhookClient]. Returns a
 * [WebhookResult] so callers (the worker, the status screen's
 * "Sync now" button) can react to retryable vs. permanent failures.
 */
class SamsungSyncManager(
  private val appContext: Context,
  private val reader: SamsungHealthReader = SamsungHealthReader(appContext),
  private val webhook: WebhookClient = WebhookClient(),
) {

  suspend fun syncToday(): WebhookResult {
    val payload = reader.buildTodayPayload()
    Log.d(
      TAG,
      "sync payload date=${payload.date} sleepScore=${payload.sleep.sleepScore} " +
        "energyScore=${payload.cardio.energyScore} warnings=${payload.sync.warnings.size}",
    )
    val result = webhook.postSamsungHealth(payload)
    when (result) {
      is WebhookResult.Success ->
        Log.i(TAG, "sync ok (${result.statusCode})")
      is WebhookResult.Retryable ->
        Log.w(TAG, "sync retryable (${result.statusCode}): ${result.message}")
      is WebhookResult.Permanent ->
        Log.e(TAG, "sync permanent (${result.statusCode}): ${result.message}")
    }
    return result
  }

  companion object {
    private const val TAG = "SamsungSyncManager"
  }
}
