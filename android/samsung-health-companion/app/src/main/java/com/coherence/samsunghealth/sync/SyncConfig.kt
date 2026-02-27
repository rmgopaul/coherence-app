package com.coherence.samsunghealth.sync

import com.coherence.samsunghealth.BuildConfig

object SyncConfig {
  const val WEBHOOK_PATH = "/api/webhooks/samsung-health"

  val webhookUrl: String = BuildConfig.WEBHOOK_URL
  val syncKey: String = BuildConfig.SYNC_KEY

  fun isConfigured(): Boolean {
    return webhookUrl.startsWith("https://") && !syncKey.contains("REPLACE") && syncKey.isNotBlank()
  }
}
