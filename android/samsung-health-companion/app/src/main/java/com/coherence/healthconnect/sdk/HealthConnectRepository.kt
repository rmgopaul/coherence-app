package com.coherence.healthconnect.sdk

import android.content.Context
import android.os.Build
import androidx.health.connect.client.HealthConnectClient
import com.coherence.healthconnect.model.ActivityMetrics
import com.coherence.healthconnect.model.BloodPressureMetrics
import com.coherence.healthconnect.model.BodyCompositionMetrics
import com.coherence.healthconnect.model.CardioMetrics
import com.coherence.healthconnect.model.GlucoseMetrics
import com.coherence.healthconnect.model.HydrationMetrics
import com.coherence.healthconnect.model.MindfulnessMetrics
import com.coherence.healthconnect.model.NutritionMetrics
import com.coherence.healthconnect.model.OxygenAndTemperatureMetrics
import com.coherence.healthconnect.model.ReproductiveHealthMetrics
import com.coherence.healthconnect.model.SampleBuckets
import com.coherence.healthconnect.model.SamsungHealthPayload
import com.coherence.healthconnect.model.SleepMetrics
import com.coherence.healthconnect.model.SourceMetadata
import com.coherence.healthconnect.model.SyncMetadata
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId

/**
 * Thin orchestrator that implements [HealthConnectPayloadSource] by
 * composing [HealthConnectPermissionManager] → [HealthConnectReader]
 * → [HealthConnectPayloadMapper].
 *
 * Prior versions of this class were ~925 lines of reflection-based
 * reads and mapping; the rewrite replaces that with typed access in
 * [HealthConnectPayloadMapper] and extracts permission/read/mapper
 * concerns into their own files.
 */
class HealthConnectRepository(
  private val context: Context,
  private val permissionManager: HealthConnectPermissionManager =
    HealthConnectPermissionManager(context),
  private val cooldown: HealthConnectCooldown = HealthConnectCooldown(context),
) : HealthConnectPayloadSource {

  override suspend fun collectDailyPayload(): SamsungHealthPayload {
    val zone = ZoneId.systemDefault()
    return collectPayloadForDate(LocalDate.now(zone))
  }

  override suspend fun collectPayloadForDate(date: LocalDate): SamsungHealthPayload {
    val zone = ZoneId.systemDefault()

    // Short-circuit if a previous run hit the rate limit. Doing
    // anything here would only make the quota hole deeper.
    val cooldownState = cooldown.getState()
    if (cooldownState.active) {
      return emptyPayload(
        date = date,
        zone = zone,
        sdkLinked = true,
        permissionsGranted = false,
        warnings = listOf(buildCooldownWarning(cooldownState)),
      )
    }

    val status = permissionManager.getStatus()

    if (!status.sdkAvailable) {
      return emptyPayload(
        date = date,
        zone = zone,
        sdkLinked = false,
        permissionsGranted = false,
        warnings = listOf(
          "Health Connect SDK not available (status=${status.sdkStatusCode}). " +
            "Install/update Health Connect and retry.",
        ),
      )
    }

    val client = HealthConnectClient.getOrCreate(context)
    val reader = HealthConnectReader(
      client = client,
      grantedPermissions = status.grantedPermissions,
      cooldown = cooldown,
    )
    if (status.missingPermissions.isNotEmpty()) {
      reader.warnings += "Missing permissions: ${status.missingPermissions.size}"
    }

    val mapper = HealthConnectPayloadMapper()
    return mapper.collectForDate(
      reader = reader,
      date = date,
      zone = zone,
      permissionsGranted = status.permissionsGranted,
    )
  }

  override suspend fun collectPayloadRange(
    startDate: LocalDate,
    endDate: LocalDate,
  ): List<SamsungHealthPayload> {
    require(!endDate.isBefore(startDate)) {
      "endDate ($endDate) must not be before startDate ($startDate)"
    }

    val zone = ZoneId.systemDefault()

    // Cooldown short-circuit — same reasoning as collectPayloadForDate.
    // For a backfill, refusing to call Health Connect at all is much
    // better than burning every day's worth of retries against an
    // already-exhausted quota.
    val cooldownState = cooldown.getState()
    if (cooldownState.active) {
      val message = buildCooldownWarning(cooldownState)
      return generateSequence(startDate) { current ->
        if (current.isBefore(endDate)) current.plusDays(1) else null
      }.map { day ->
        emptyPayload(
          date = day,
          zone = zone,
          sdkLinked = true,
          permissionsGranted = false,
          warnings = listOf(message),
        )
      }.toList()
    }

    val status = permissionManager.getStatus()

    if (!status.sdkAvailable) {
      // Emit a stub payload per day so the webhook still gets a shape
      // per requested date (matches the single-day path's behavior).
      val warnings = listOf(
        "Health Connect SDK not available (status=${status.sdkStatusCode}). " +
          "Install/update Health Connect and retry.",
      )
      return generateSequence(startDate) { current ->
        if (current.isBefore(endDate)) current.plusDays(1) else null
      }.map { day ->
        emptyPayload(
          date = day,
          zone = zone,
          sdkLinked = false,
          permissionsGranted = false,
          warnings = warnings,
        )
      }.toList()
    }

    val client = HealthConnectClient.getOrCreate(context)
    val reader = HealthConnectReader(
      client = client,
      grantedPermissions = status.grantedPermissions,
      cooldown = cooldown,
    )
    if (status.missingPermissions.isNotEmpty()) {
      reader.warnings += "Missing permissions: ${status.missingPermissions.size}"
    }

    // Single set of range-scoped reads — 22 API calls total,
    // regardless of how many days the range spans. This is the
    // rate-limit fix for the historical backfill path.
    val mapper = HealthConnectPayloadMapper()
    return try {
      mapper.collectForDateRange(
        reader = reader,
        startDate = startDate,
        endDate = endDate,
        zone = zone,
        permissionsGranted = status.permissionsGranted,
      )
    } catch (error: Throwable) {
      // If the whole range read fails at the mapper level (unlikely
      // since the reader already swallows per-type errors), fall back
      // to stub payloads so the caller still sees a shape per date.
      val message = error.message ?: error.javaClass.simpleName
      generateSequence(startDate) { current ->
        if (current.isBefore(endDate)) current.plusDays(1) else null
      }.map { day ->
        emptyPayload(
          date = day,
          zone = zone,
          sdkLinked = true,
          permissionsGranted = status.permissionsGranted,
          warnings = listOf("Range collection failed: $message"),
        )
      }.toList()
    }
  }

  override suspend fun getConnectionStatus(): HealthConnectStatus {
    return permissionManager.getStatus()
  }

  /**
   * Compose the warning string used when a payload is short-circuited
   * by an active rate-limit cooldown. Centralized so the per-day,
   * per-range, and UI surfaces all phrase it the same way.
   */
  private fun buildCooldownWarning(state: HealthConnectCooldown.State): String {
    val until = state.until
    val untilText = if (until != null) until.toString() else "(unknown)"
    val reason = state.lastMessage?.let { " — last error: $it" } ?: ""
    return "Health Connect rate limit cooldown active until $untilText. " +
      "Skipping read to let the quota replenish.$reason"
  }

  private fun emptyPayload(
    date: LocalDate,
    zone: ZoneId,
    sdkLinked: Boolean,
    permissionsGranted: Boolean,
    warnings: List<String>,
  ): SamsungHealthPayload {
    val capturedAt = OffsetDateTime.now(zone)
    return SamsungHealthPayload(
      date = date.toString(),
      capturedAtIso = capturedAt.toString(),
      timezone = zone.id,
      source = SourceMetadata(
        provider = "health-connect",
        appVersion = APP_VERSION,
        deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}",
        osVersion = "Android ${Build.VERSION.RELEASE}",
      ),
      activity = ActivityMetrics(
        steps = 0,
        distanceMeters = 0.0,
        floorsClimbed = 0.0,
        activeMinutes = 0,
        sedentaryMinutes = 0,
        exerciseMinutes = 0,
        caloriesActiveKcal = 0.0,
        caloriesBasalKcal = 0.0,
        caloriesTotalKcal = 0.0,
        walkingDurationMinutes = 0,
        runningDurationMinutes = 0,
        cyclingDurationMinutes = 0,
        swimmingDurationMinutes = 0,
        exerciseSessionCount = 0,
      ),
      sleep = SleepMetrics(
        totalSleepMinutes = 0,
        inBedMinutes = 0,
        awakeMinutes = 0,
        lightMinutes = 0,
        deepMinutes = 0,
        remMinutes = 0,
        sleepOnsetLatencyMinutes = 0,
        wakeAfterSleepOnsetMinutes = 0,
        sleepEfficiencyPercent = 0.0,
        sleepConsistencyPercent = 0.0,
        sleepScore = 0.0,
      ),
      cardio = CardioMetrics(
        restingHeartRateBpm = 0.0,
        averageHeartRateBpm = 0.0,
        minHeartRateBpm = 0.0,
        maxHeartRateBpm = 0.0,
        hrvRmssdMs = 0.0,
        hrvSdnnMs = 0.0,
        respiratoryRateBrpm = 0.0,
        vo2MaxMlKgMin = 0.0,
        stressScore = 0.0,
        stressMinutes = 0,
      ),
      oxygenAndTemperature = OxygenAndTemperatureMetrics(
        spo2AvgPercent = 0.0,
        spo2MinPercent = 0.0,
        skinTemperatureCelsius = 0.0,
        bodyTemperatureCelsius = 0.0,
      ),
      bloodPressure = BloodPressureMetrics(
        systolicMmHg = 0.0,
        diastolicMmHg = 0.0,
        pulseBpm = 0.0,
      ),
      bodyComposition = BodyCompositionMetrics(
        weightKg = 0.0,
        bmi = 0.0,
        bodyFatPercent = 0.0,
        skeletalMuscleMassKg = 0.0,
        bodyWaterPercent = 0.0,
        basalMetabolicRateKcal = 0.0,
      ),
      nutrition = NutritionMetrics(
        caloriesIntakeKcal = 0.0,
        proteinGrams = 0.0,
        carbsGrams = 0.0,
        fatGrams = 0.0,
        saturatedFatGrams = 0.0,
        sugarGrams = 0.0,
        fiberGrams = 0.0,
        sodiumMg = 0.0,
        cholesterolMg = 0.0,
        caffeineMg = 0.0,
      ),
      hydration = HydrationMetrics(waterMl = 0.0),
      glucose = GlucoseMetrics(
        fastingMgDl = 0.0,
        avgMgDl = 0.0,
        maxMgDl = 0.0,
      ),
      mindfulness = MindfulnessMetrics(
        mindfulMinutes = 0,
        meditationMinutes = 0,
      ),
      reproductiveHealth = ReproductiveHealthMetrics(),
      samples = SampleBuckets(),
      sync = SyncMetadata(
        sdkLinked = sdkLinked,
        permissionsGranted = permissionsGranted,
        recordTypesAttempted = emptyList(),
        recordTypesSucceeded = emptyList(),
        warnings = warnings,
      ),
    )
  }

  companion object {
    // Keep in sync with HealthConnectPayloadMapper.APP_VERSION.
    private const val APP_VERSION = "0.5.3"
  }
}
