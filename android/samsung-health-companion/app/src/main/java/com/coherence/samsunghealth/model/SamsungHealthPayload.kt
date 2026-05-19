package com.coherence.samsunghealth.model

import kotlinx.serialization.Serializable

/**
 * Wire model for `POST /api/webhooks/samsung-health`.
 *
 * This is a faithful copy of the `healthconnect-companion` module's
 * `SamsungHealthPayload` so the existing server endpoint
 * (`ingestSamsungPayload` in `server/oauth-routes.ts`) parses it
 * unchanged — same field names, same nesting, same `@Serializable`
 * defaults. The server tolerates extra/missing keys
 * (`Json { ignoreUnknownKeys = true }`), so this minimal companion
 * only populates the fields it actually reads from the Samsung
 * Health Data SDK (sleep score + energy score + the sync block) and
 * leaves the rest at their zero defaults.
 *
 * One addition vs. the HC model: [CardioMetrics.energyScore]. The HC
 * model had `sleep.sleepScore` but no field for Samsung's Energy
 * Score. See the class doc on [CardioMetrics] and the PR description
 * for the matching server-side follow-up required to persist it.
 */
@Serializable
data class SamsungHealthPayload(
  val date: String,
  val capturedAtIso: String,
  val timezone: String,
  val source: SourceMetadata,
  val activity: ActivityMetrics,
  val sleep: SleepMetrics,
  val cardio: CardioMetrics,
  val sync: SyncMetadata,
)

@Serializable
data class SourceMetadata(
  val provider: String = "samsung-health-data-sdk",
  val appVersion: String,
  val deviceModel: String,
  val osVersion: String,
)

@Serializable
data class ActivityMetrics(
  val steps: Int = 0,
  val distanceMeters: Double = 0.0,
  val floorsClimbed: Double = 0.0,
  val activeMinutes: Int = 0,
  val sedentaryMinutes: Int = 0,
  val exerciseMinutes: Int = 0,
  val caloriesActiveKcal: Double = 0.0,
  val caloriesBasalKcal: Double = 0.0,
  val caloriesTotalKcal: Double = 0.0,
  val walkingDurationMinutes: Int = 0,
  val runningDurationMinutes: Int = 0,
  val cyclingDurationMinutes: Int = 0,
  val swimmingDurationMinutes: Int = 0,
  val exerciseSessionCount: Int = 0,
)

@Serializable
data class SleepMetrics(
  val totalSleepMinutes: Int = 0,
  val inBedMinutes: Int = 0,
  val awakeMinutes: Int = 0,
  val lightMinutes: Int = 0,
  val deepMinutes: Int = 0,
  val remMinutes: Int = 0,
  val sleepOnsetLatencyMinutes: Int = 0,
  val wakeAfterSleepOnsetMinutes: Int = 0,
  val sleepEfficiencyPercent: Double = 0.0,
  val sleepConsistencyPercent: Double = 0.0,
  /**
   * Samsung's proprietary Sleep Score (0–100), read directly from
   * `DataType.SleepType.SLEEP_SCORE` (a `Field<Integer>`). Already
   * an integer on the device; kept as `Double` here only to stay
   * shape-identical to the HC companion's model (the server's
   * `asNumber(...)` coerces either form).
   */
  val sleepScore: Double = 0.0,
  val bedtimeIso: String? = null,
  val wakeTimeIso: String? = null,
)

@Serializable
data class CardioMetrics(
  val restingHeartRateBpm: Double = 0.0,
  val averageHeartRateBpm: Double = 0.0,
  val minHeartRateBpm: Double = 0.0,
  val maxHeartRateBpm: Double = 0.0,
  val hrvRmssdMs: Double = 0.0,
  val hrvSdnnMs: Double = 0.0,
  val respiratoryRateBrpm: Double = 0.0,
  val vo2MaxMlKgMin: Double = 0.0,
  val stressScore: Double = 0.0,
  val stressMinutes: Int = 0,
  /**
   * Samsung's proprietary Energy Score, read from
   * `DataType.EnergyScoreType.ENERGY_SCORE` (a `Field<Float>`).
   *
   * The SDK exposes a `Float`; the server's `samsungEnergyScore`
   * column stores a rounded `Int` (the CSV importer does
   * `round(total_score)`), so [SamsungHealthReader] rounds the
   * Float to the nearest Int before placing it here. This field is
   * a NEW addition relative to the healthconnect-companion model
   * (which had no Energy Score field at all).
   *
   * NOTE — server follow-up required: as of this PR
   * `server/oauth-routes.ts` `buildSamsungMetadata()` derives
   * `summary.energyScore` ONLY from the integration's manual-score
   * slot (`manualScores.energyScore`), never from the inbound
   * payload. Until the server is taught to read
   * `payload.cardio.energyScore` (and likewise
   * `payload.sleep.sleepScore`), this value is accepted and stored
   * in `samsungSyncPayloads` but does NOT flow into the
   * `dailyHealthMetrics.samsungEnergyScore` column. See the PR
   * description for the exact one-line server change.
   */
  val energyScore: Double = 0.0,
)

@Serializable
data class SyncMetadata(
  val sdkLinked: Boolean,
  val permissionsGranted: Boolean,
  val recordTypesAttempted: List<String>,
  val recordTypesSucceeded: List<String>,
  val warnings: List<String>,
)
