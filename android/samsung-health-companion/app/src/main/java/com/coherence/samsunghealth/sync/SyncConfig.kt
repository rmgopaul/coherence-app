package com.coherence.samsunghealth.sync

import com.coherence.samsunghealth.BuildConfig

/**
 * Static configuration for the Samsung Health → productivity-hub
 * sync bridge. Values are baked into BuildConfig by
 * `app/build.gradle.kts` from `local.properties`
 * (`SAMSUNG_HEALTH_SYNC_KEY` / `SAMSUNG_HEALTH_WEBHOOK_URL`) — the
 * SAME keys the healthconnect-companion module reads, so one
 * `local.properties` configures both.
 *
 * Mirrors `healthconnect-companion`'s `SyncConfig` (single-day path
 * only — this minimal companion does not do historical batch
 * backfill).
 */
object SyncConfig {
  const val WEBHOOK_PATH = "/api/webhooks/samsung-health"

  val webhookUrl: String = BuildConfig.WEBHOOK_URL

  val syncKey: String = BuildConfig.SYNC_KEY

  fun isConfigured(): Boolean {
    return webhookUrl.startsWith("https://") &&
      !syncKey.contains("REPLACE") &&
      syncKey.isNotBlank()
  }
}
