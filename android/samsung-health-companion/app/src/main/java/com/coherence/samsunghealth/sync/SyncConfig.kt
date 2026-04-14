package com.coherence.samsunghealth.sync

import com.coherence.samsunghealth.BuildConfig

/**
 * Static configuration for the Samsung Health → productivity-hub
 * sync bridge. Values are baked into BuildConfig by `build.gradle.kts`
 * and should ultimately migrate to `local.properties` / a secrets
 * manager rather than being committed.
 */
object SyncConfig {
  const val WEBHOOK_PATH = "/api/webhooks/samsung-health"
  const val WEBHOOK_BATCH_PATH = "/api/webhooks/samsung-health/batch"

  val webhookUrl: String = BuildConfig.WEBHOOK_URL

  /**
   * URL for the batch endpoint. Derived from [webhookUrl] by
   * replacing its trailing single-day path with the batch suffix,
   * so it works regardless of whether callers build against a
   * staging or production base URL.
   */
  val batchWebhookUrl: String = run {
    val single = BuildConfig.WEBHOOK_URL
    if (single.endsWith(WEBHOOK_PATH)) {
      single.removeSuffix(WEBHOOK_PATH) + WEBHOOK_BATCH_PATH
    } else {
      // Fallback: append "/batch" to whatever path was configured.
      single.trimEnd('/') + "/batch"
    }
  }

  val syncKey: String = BuildConfig.SYNC_KEY

  fun isConfigured(): Boolean {
    return webhookUrl.startsWith("https://") &&
      !syncKey.contains("REPLACE") &&
      syncKey.isNotBlank()
  }
}
