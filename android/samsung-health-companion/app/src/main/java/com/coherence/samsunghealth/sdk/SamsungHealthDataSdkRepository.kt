package com.coherence.samsunghealth.sdk

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.BodyWaterMassRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.coherence.samsunghealth.model.ActivityMetrics
import com.coherence.samsunghealth.model.BloodPressureMetrics
import com.coherence.samsunghealth.model.BloodPressureSample
import com.coherence.samsunghealth.model.BodyCompositionMetrics
import com.coherence.samsunghealth.model.CardioMetrics
import com.coherence.samsunghealth.model.GlucoseMetrics
import com.coherence.samsunghealth.model.HydrationMetrics
import com.coherence.samsunghealth.model.MindfulnessMetrics
import com.coherence.samsunghealth.model.NutritionMetrics
import com.coherence.samsunghealth.model.OxygenAndTemperatureMetrics
import com.coherence.samsunghealth.model.ReproductiveHealthMetrics
import com.coherence.samsunghealth.model.SampleBuckets
import com.coherence.samsunghealth.model.SamsungHealthPayload
import com.coherence.samsunghealth.model.SleepMetrics
import com.coherence.samsunghealth.model.SleepSessionSample
import com.coherence.samsunghealth.model.SleepStageSample
import com.coherence.samsunghealth.model.SourceMetadata
import com.coherence.samsunghealth.model.SyncMetadata
import com.coherence.samsunghealth.model.TimedValueSample
import com.coherence.samsunghealth.model.WorkoutSample
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import kotlin.math.roundToInt

class SamsungHealthDataSdkRepository(
  private val context: Context,
) : SamsungHealthRepository {

  private data class TimeInterval(
    val start: Instant,
    val end: Instant,
  )

  data class ConnectionStatus(
    val sdkAvailable: Boolean,
    val permissionsGranted: Boolean,
    val grantedPermissions: Set<String>,
    val missingPermissions: Set<String>,
    val sdkStatusCode: Int,
  )

  companion object {
    const val HEALTH_CONNECT_PROVIDER_PACKAGE = "com.google.android.apps.healthdata"

    val coreReadPermissions: Set<String> = setOf(
      HealthPermission.getReadPermission(StepsRecord::class),
      HealthPermission.getReadPermission(DistanceRecord::class),
      HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
      HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
      HealthPermission.getReadPermission(ExerciseSessionRecord::class),
      HealthPermission.getReadPermission(SleepSessionRecord::class),
      HealthPermission.getReadPermission(HeartRateRecord::class),
    )

    val optionalReadPermissions: Set<String> = setOf(
      HealthPermission.getReadPermission(RestingHeartRateRecord::class),
      HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
      HealthPermission.getReadPermission(RespiratoryRateRecord::class),
      HealthPermission.getReadPermission(OxygenSaturationRecord::class),
      HealthPermission.getReadPermission(BloodPressureRecord::class),
      HealthPermission.getReadPermission(BloodGlucoseRecord::class),
      HealthPermission.getReadPermission(WeightRecord::class),
      HealthPermission.getReadPermission(BodyFatRecord::class),
      HealthPermission.getReadPermission(BodyWaterMassRecord::class),
      HealthPermission.getReadPermission(BasalMetabolicRateRecord::class),
      HealthPermission.getReadPermission(HydrationRecord::class),
      HealthPermission.getReadPermission(NutritionRecord::class),
      HealthPermission.getReadPermission(BodyTemperatureRecord::class),
    )

    val requiredReadPermissions: Set<String> = coreReadPermissions + optionalReadPermissions

    fun getSdkStatus(context: Context): Int {
      return HealthConnectClient.getSdkStatus(context, HEALTH_CONNECT_PROVIDER_PACKAGE)
    }

    fun buildHealthConnectSettingsIntent(): Intent {
      return Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
    }
  }

  suspend fun getConnectionStatus(): ConnectionStatus {
    val sdkStatus = getSdkStatus(context)
    val sdkAvailable = sdkStatus == HealthConnectClient.SDK_AVAILABLE
    if (!sdkAvailable) {
      return ConnectionStatus(
        sdkAvailable = false,
        permissionsGranted = false,
        grantedPermissions = emptySet(),
        missingPermissions = requiredReadPermissions,
        sdkStatusCode = sdkStatus,
      )
    }

    val client = HealthConnectClient.getOrCreate(context)
    val granted = client.permissionController.getGrantedPermissions()
    val missing = requiredReadPermissions - granted

    return ConnectionStatus(
      sdkAvailable = true,
      permissionsGranted = missing.isEmpty(),
      grantedPermissions = granted,
      missingPermissions = missing,
      sdkStatusCode = sdkStatus,
    )
  }

  override suspend fun collectDailyPayload(): SamsungHealthPayload {
    val zone = ZoneId.systemDefault()
    val today = LocalDate.now(zone)
    val now = OffsetDateTime.now()
    val dayStart = today.atStartOfDay(zone).toInstant()
    val nowInstant = now.toInstant()
    val dayRange = TimeRangeFilter.between(dayStart, nowInstant)
    val sleepWindowStart = dayStart.minus(Duration.ofHours(18))
    val sleepRange = TimeRangeFilter.between(sleepWindowStart, nowInstant)
    val sleepMetricWindowStart = nowInstant.minus(Duration.ofHours(24))
    val sleepMetricWindowEnd = nowInstant

    val attempted = mutableListOf<String>()
    val succeeded = mutableListOf<String>()
    val warnings = mutableListOf<String>()

    val sdkStatus = getSdkStatus(context)
    if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) {
      warnings += "Health Connect SDK not available (status=$sdkStatus). Install/update Health Connect and retry."
      return createEmptyPayload(
        date = today.toString(),
        capturedAtIso = now.toString(),
        timezone = zone.id,
        sdkLinked = false,
        permissionsGranted = false,
        attempted = attempted,
        succeeded = succeeded,
        warnings = warnings,
      )
    }

    val client = HealthConnectClient.getOrCreate(context)
    val grantedPermissions = client.permissionController.getGrantedPermissions()
    val missingPermissions = requiredReadPermissions - grantedPermissions
    val missingCore = coreReadPermissions - grantedPermissions
    if (missingPermissions.isNotEmpty()) {
      warnings += "Missing permissions: ${missingPermissions.size}"
    }

    val stepsRecords = readIfPermitted<StepsRecord>(
      client, dayRange, "steps", HealthPermission.getReadPermission(StepsRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val distanceRecords = readIfPermitted<DistanceRecord>(
      client, dayRange, "distance", HealthPermission.getReadPermission(DistanceRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val floorsRecords = readIfPermitted<FloorsClimbedRecord>(
      client, dayRange, "floors", HealthPermission.getReadPermission(FloorsClimbedRecord::class), grantedPermissions, attempted, succeeded, warnings, warnIfMissing = false
    )
    val activeCalRecords = readIfPermitted<ActiveCaloriesBurnedRecord>(
      client, dayRange, "active_calories", HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val totalCalRecords = readIfPermitted<TotalCaloriesBurnedRecord>(
      client, dayRange, "total_calories", HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val exerciseRecords = readIfPermitted<ExerciseSessionRecord>(
      client, dayRange, "exercise_sessions", HealthPermission.getReadPermission(ExerciseSessionRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val sleepRecords = readIfPermitted<SleepSessionRecord>(
      client, sleepRange, "sleep_sessions", HealthPermission.getReadPermission(SleepSessionRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val heartRateRecords = readIfPermitted<HeartRateRecord>(
      client, dayRange, "heart_rate", HealthPermission.getReadPermission(HeartRateRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val restingHrRecords = readIfPermitted<RestingHeartRateRecord>(
      client, dayRange, "resting_heart_rate", HealthPermission.getReadPermission(RestingHeartRateRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val hrvRecords = readIfPermitted<HeartRateVariabilityRmssdRecord>(
      client, dayRange, "hrv", HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val respiratoryRecords = readIfPermitted<RespiratoryRateRecord>(
      client, dayRange, "respiratory_rate", HealthPermission.getReadPermission(RespiratoryRateRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val spo2Records = readIfPermitted<OxygenSaturationRecord>(
      client, dayRange, "oxygen_saturation", HealthPermission.getReadPermission(OxygenSaturationRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val bloodPressureRecords = readIfPermitted<BloodPressureRecord>(
      client, dayRange, "blood_pressure", HealthPermission.getReadPermission(BloodPressureRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val glucoseRecords = readIfPermitted<BloodGlucoseRecord>(
      client, dayRange, "blood_glucose", HealthPermission.getReadPermission(BloodGlucoseRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val weightRecords = readIfPermitted<WeightRecord>(
      client, dayRange, "weight", HealthPermission.getReadPermission(WeightRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val bodyFatRecords = readIfPermitted<BodyFatRecord>(
      client, dayRange, "body_fat", HealthPermission.getReadPermission(BodyFatRecord::class), grantedPermissions, attempted, succeeded, warnings, suppressForegroundRequirementWarning = true
    )
    val bodyWaterMassRecords = readIfPermitted<BodyWaterMassRecord>(
      client, dayRange, "body_water_mass", HealthPermission.getReadPermission(BodyWaterMassRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val bmrRecords = readIfPermitted<BasalMetabolicRateRecord>(
      client, dayRange, "bmr", HealthPermission.getReadPermission(BasalMetabolicRateRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val hydrationRecords = readIfPermitted<HydrationRecord>(
      client, dayRange, "hydration", HealthPermission.getReadPermission(HydrationRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val nutritionRecords = readIfPermitted<NutritionRecord>(
      client, dayRange, "nutrition", HealthPermission.getReadPermission(NutritionRecord::class), grantedPermissions, attempted, succeeded, warnings
    )
    val vo2Records = readIfPermitted<Vo2MaxRecord>(
      client, dayRange, "vo2", HealthPermission.getReadPermission(Vo2MaxRecord::class), grantedPermissions, attempted, succeeded, warnings, warnIfMissing = false
    )
    val bodyTemperatureRecords = readIfPermitted<BodyTemperatureRecord>(
      client, dayRange, "body_temperature", HealthPermission.getReadPermission(BodyTemperatureRecord::class), grantedPermissions, attempted, succeeded, warnings
    )

    val steps = stepsRecords.sumOf { getLong(it, "count") ?: 0L }.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    val distanceMeters = distanceRecords.sumOf { getUnitDouble(getValue(it, "distance")) ?: 0.0 }
    val floorsClimbed = floorsRecords.sumOf { getDouble(it, "floors") ?: 0.0 }
    val caloriesActiveKcal = activeCalRecords.sumOf { getUnitDouble(getValue(it, "energy")) ?: 0.0 }
    val caloriesTotalKcal = totalCalRecords.sumOf { getUnitDouble(getValue(it, "energy")) ?: 0.0 }

    val exerciseMinutes = exerciseRecords.sumOf { durationMinutes(getInstant(it, "startTime"), getInstant(it, "endTime")) }

    val sleepStageSamples = mutableListOf<SleepStageSample>()
    val sleepSessionIntervals = mutableListOf<TimeInterval>()
    val awakeStageIntervals = mutableListOf<TimeInterval>()
    val lightStageIntervals = mutableListOf<TimeInterval>()
    val deepStageIntervals = mutableListOf<TimeInterval>()
    val remStageIntervals = mutableListOf<TimeInterval>()
    val otherSleepStageIntervals = mutableListOf<TimeInterval>()
    val sleepSessionSamples = sleepRecords.mapNotNull { record ->
      val start = getInstant(record, "startTime") ?: return@mapNotNull null
      val end = getInstant(record, "endTime") ?: return@mapNotNull null
      val clippedSession = clipInterval(start, end, sleepMetricWindowStart, sleepMetricWindowEnd)
        ?: return@mapNotNull null
      sleepSessionIntervals += clippedSession

      val stageList = getValue(record, "stages") as? Iterable<*>
      if (stageList != null) {
        for (stage in stageList) {
          val stageStart = getInstant(stage, "startTime") ?: continue
          val stageEnd = getInstant(stage, "endTime") ?: continue
          val clippedStage = clipInterval(stageStart, stageEnd, sleepMetricWindowStart, sleepMetricWindowEnd)
            ?: continue
          val minutes = durationMinutes(clippedStage.start, clippedStage.end)
          val stageCode = getInt(stage, "stage") ?: -1
          val stageLabel = when (stageCode) {
            1, 2 -> {
              awakeStageIntervals += clippedStage
              "awake"
            }

            4 -> {
              lightStageIntervals += clippedStage
              "light"
            }

            5 -> {
              deepStageIntervals += clippedStage
              "deep"
            }

            6 -> {
              remStageIntervals += clippedStage
              "rem"
            }

            else -> {
              otherSleepStageIntervals += clippedStage
              "other"
            }
          }

          sleepStageSamples += SleepStageSample(
            stage = stageLabel,
            startIso = clippedStage.start.toString(),
            endIso = clippedStage.end.toString(),
            minutes = minutes,
          )
        }
      }

      SleepSessionSample(
        startIso = clippedSession.start.toString(),
        endIso = clippedSession.end.toString(),
        score = getDouble(record, "title") ?: 0.0,
      )
    }

    val mergedInBedIntervals = mergeIntervals(sleepSessionIntervals)
    val mergedAwakeIntervals = mergeIntervals(awakeStageIntervals)
    val mergedLightIntervals = mergeIntervals(lightStageIntervals)
    val mergedDeepIntervals = mergeIntervals(deepStageIntervals)
    val mergedRemIntervals = mergeIntervals(remStageIntervals)
    val mergedOtherSleepIntervals = mergeIntervals(otherSleepStageIntervals)
    val mergedAsleepIntervals = mergeIntervals(
      mergedLightIntervals + mergedDeepIntervals + mergedRemIntervals + mergedOtherSleepIntervals
    )

    val inBedMinutes = totalMinutes(mergedInBedIntervals)
    val awakeMinutes = totalMinutes(mergedAwakeIntervals).coerceAtMost(inBedMinutes)
    val lightMinutes = totalMinutes(mergedLightIntervals)
    val deepMinutes = totalMinutes(mergedDeepIntervals)
    val remMinutes = totalMinutes(mergedRemIntervals)
    val totalSleepMinutes = run {
      val fromStages = totalMinutes(mergedAsleepIntervals)
      if (fromStages > 0) fromStages else (inBedMinutes - awakeMinutes).coerceAtLeast(0)
    }

    val heartRateSeries = mutableListOf<TimedValueSample>()
    val heartRateValues = mutableListOf<Double>()
    for (record in heartRateRecords) {
      val samples = getValue(record, "samples") as? Iterable<*> ?: continue
      for (sample in samples) {
        val bpm = getDouble(sample, "beatsPerMinute") ?: continue
        val sampleTime = getInstant(sample, "time") ?: continue
        heartRateValues += bpm
        heartRateSeries += TimedValueSample(
          atIso = sampleTime.toString(),
          value = bpm,
          unit = "bpm",
        )
      }
    }

    val restingHeartRate = restingHrRecords
      .mapNotNull { getDouble(it, "beatsPerMinute") }
      .averageOrZero()

    val hrvRmssd = hrvRecords
      .mapNotNull { getDouble(it, "heartRateVariabilityMillis", "rmssdMillis") }
      .averageOrZero()

    val respiratoryRate = respiratoryRecords
      .mapNotNull { getDouble(it, "rate", "respiratoryRate") }
      .averageOrZero()

    val vo2 = vo2Records
      .mapNotNull { getDouble(it, "vo2MillilitersPerMinuteKilogram") }
      .averageOrZero()

    val spo2Series = spo2Records.mapNotNull { record ->
      val at = getInstant(record, "time") ?: return@mapNotNull null
      val value = getUnitDouble(getValue(record, "percentage")) ?: return@mapNotNull null
      TimedValueSample(
        atIso = at.toString(),
        value = value,
        unit = "%",
      )
    }

    val spo2Values = spo2Series.map { it.value }

    val bloodPressureSeries = bloodPressureRecords.mapNotNull { record ->
      val at = getInstant(record, "time") ?: return@mapNotNull null
      val systolic = getUnitDouble(getValue(record, "systolic")) ?: return@mapNotNull null
      val diastolic = getUnitDouble(getValue(record, "diastolic")) ?: return@mapNotNull null
      val pulse = getDouble(record, "heartRate") ?: 0.0
      BloodPressureSample(
        atIso = at.toString(),
        systolicMmHg = systolic,
        diastolicMmHg = diastolic,
        pulseBpm = pulse,
      )
    }

    val latestBloodPressure = bloodPressureSeries.maxByOrNull { it.atIso }

    val glucoseSeries = glucoseRecords.mapNotNull { record ->
      val at = getInstant(record, "time") ?: return@mapNotNull null
      val value = getUnitDouble(getValue(record, "level")) ?: return@mapNotNull null
      TimedValueSample(
        atIso = at.toString(),
        value = value,
        unit = "mg/dL",
      )
    }

    val glucoseValues = glucoseSeries.map { it.value }

    val latestWeightKg = weightRecords
      .maxByOrNull { getInstant(it, "time") ?: Instant.MIN }
      ?.let { getUnitDouble(getValue(it, "weight")) }
      ?: 0.0

    val latestBodyFatPercent = bodyFatRecords
      .maxByOrNull { getInstant(it, "time") ?: Instant.MIN }
      ?.let { getUnitDouble(getValue(it, "percentage")) }
      ?: 0.0

    val latestBodyWaterMassKg = bodyWaterMassRecords
      .maxByOrNull { getInstant(it, "time") ?: Instant.MIN }
      ?.let { getUnitDouble(getValue(it, "mass")) }
      ?: 0.0

    val bmr = bmrRecords
      .maxByOrNull { getInstant(it, "time") ?: Instant.MIN }
      ?.let { getUnitDouble(getValue(it, "basalMetabolicRate")) }
      ?: 0.0

    val waterMl = hydrationRecords.sumOf { record ->
      val volume = getUnitDouble(getValue(record, "volume")) ?: 0.0
      when {
        volume < 10.0 -> volume * 1000.0
        else -> volume
      }
    }

    val caloriesIntake = nutritionRecords.sumOf { getUnitDouble(getValue(it, "energy")) ?: 0.0 }
    val protein = nutritionRecords.sumOf { getUnitDouble(getValue(it, "protein")) ?: 0.0 }
    val carbs = nutritionRecords.sumOf { getUnitDouble(getValue(it, "totalCarbohydrate", "carbohydrate")) ?: 0.0 }
    val fat = nutritionRecords.sumOf { getUnitDouble(getValue(it, "totalFat", "fat")) ?: 0.0 }
    val saturatedFat = nutritionRecords.sumOf { getUnitDouble(getValue(it, "saturatedFat")) ?: 0.0 }
    val sugar = nutritionRecords.sumOf { getUnitDouble(getValue(it, "sugar")) ?: 0.0 }
    val fiber = nutritionRecords.sumOf { getUnitDouble(getValue(it, "dietaryFiber", "fiber")) ?: 0.0 }
    val sodium = nutritionRecords.sumOf { getUnitDouble(getValue(it, "sodium")) ?: 0.0 }
    val cholesterol = nutritionRecords.sumOf { getUnitDouble(getValue(it, "cholesterol")) ?: 0.0 }
    val caffeine = nutritionRecords.sumOf { getUnitDouble(getValue(it, "caffeine")) ?: 0.0 }

    val latestBodyTemp = bodyTemperatureRecords
      .maxByOrNull { getInstant(it, "time") ?: Instant.MIN }
      ?.let { getUnitDouble(getValue(it, "temperature")) }
      ?: 0.0

    val workouts = exerciseRecords.mapNotNull { record ->
      val start = getInstant(record, "startTime") ?: return@mapNotNull null
      val end = getInstant(record, "endTime") ?: return@mapNotNull null
      val duration = durationMinutes(start, end)
      val typeRaw = getValue(record, "exerciseType")?.toString() ?: "unknown"
      WorkoutSample(
        type = typeRaw,
        startIso = start.toString(),
        endIso = end.toString(),
        durationMinutes = duration,
        caloriesKcal = getUnitDouble(getValue(record, "energy", "totalEnergyBurned")) ?: 0.0,
        distanceMeters = getUnitDouble(getValue(record, "distance", "totalDistance")) ?: 0.0,
        avgHeartRateBpm = getDouble(record, "averageHeartRate") ?: 0.0,
        maxHeartRateBpm = getDouble(record, "maxHeartRate") ?: 0.0,
      )
    }

    val sleepEfficiency = if (inBedMinutes > 0) {
      ((totalSleepMinutes).coerceAtLeast(0).toDouble() / inBedMinutes.toDouble()) * 100.0
    } else {
      0.0
    }

    val bodyWaterPercent = if (latestWeightKg > 0) {
      (latestBodyWaterMassKg / latestWeightKg) * 100.0
    } else {
      0.0
    }

    return SamsungHealthPayload(
      date = today.toString(),
      capturedAtIso = now.toString(),
      timezone = zone.id,
      source = SourceMetadata(
        provider = "health-connect",
        appVersion = "0.2.0",
        deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}",
        osVersion = "Android ${Build.VERSION.RELEASE}",
      ),
      activity = ActivityMetrics(
        steps = steps,
        distanceMeters = distanceMeters,
        floorsClimbed = floorsClimbed,
        activeMinutes = exerciseMinutes,
        sedentaryMinutes = 0,
        exerciseMinutes = exerciseMinutes,
        caloriesActiveKcal = caloriesActiveKcal,
        caloriesBasalKcal = 0.0,
        caloriesTotalKcal = caloriesTotalKcal,
        walkingDurationMinutes = 0,
        runningDurationMinutes = 0,
        cyclingDurationMinutes = 0,
        swimmingDurationMinutes = 0,
        exerciseSessionCount = workouts.size,
      ),
      sleep = SleepMetrics(
        totalSleepMinutes = totalSleepMinutes,
        inBedMinutes = inBedMinutes,
        awakeMinutes = awakeMinutes,
        lightMinutes = lightMinutes,
        deepMinutes = deepMinutes,
        remMinutes = remMinutes,
        sleepOnsetLatencyMinutes = 0,
        wakeAfterSleepOnsetMinutes = 0,
        sleepEfficiencyPercent = sleepEfficiency,
        sleepConsistencyPercent = 0.0,
        sleepScore = 0.0,
        bedtimeIso = sleepSessionSamples.minByOrNull { it.startIso }?.startIso,
        wakeTimeIso = sleepSessionSamples.maxByOrNull { it.endIso }?.endIso,
      ),
      cardio = CardioMetrics(
        restingHeartRateBpm = restingHeartRate,
        averageHeartRateBpm = heartRateValues.averageOrZero(),
        minHeartRateBpm = heartRateValues.minOrNull() ?: 0.0,
        maxHeartRateBpm = heartRateValues.maxOrNull() ?: 0.0,
        hrvRmssdMs = hrvRmssd,
        hrvSdnnMs = 0.0,
        respiratoryRateBrpm = respiratoryRate,
        vo2MaxMlKgMin = vo2,
        stressScore = 0.0,
        stressMinutes = 0,
      ),
      oxygenAndTemperature = OxygenAndTemperatureMetrics(
        spo2AvgPercent = spo2Values.averageOrZero(),
        spo2MinPercent = spo2Values.minOrNull() ?: 0.0,
        skinTemperatureCelsius = 0.0,
        bodyTemperatureCelsius = latestBodyTemp,
      ),
      bloodPressure = BloodPressureMetrics(
        systolicMmHg = latestBloodPressure?.systolicMmHg ?: 0.0,
        diastolicMmHg = latestBloodPressure?.diastolicMmHg ?: 0.0,
        pulseBpm = latestBloodPressure?.pulseBpm ?: 0.0,
      ),
      bodyComposition = BodyCompositionMetrics(
        weightKg = latestWeightKg,
        bmi = computeBmi(latestWeightKg),
        bodyFatPercent = latestBodyFatPercent,
        skeletalMuscleMassKg = 0.0,
        bodyWaterPercent = bodyWaterPercent,
        basalMetabolicRateKcal = bmr,
      ),
      nutrition = NutritionMetrics(
        caloriesIntakeKcal = caloriesIntake,
        proteinGrams = protein,
        carbsGrams = carbs,
        fatGrams = fat,
        saturatedFatGrams = saturatedFat,
        sugarGrams = sugar,
        fiberGrams = fiber,
        sodiumMg = sodium,
        cholesterolMg = cholesterol,
        caffeineMg = caffeine,
      ),
      hydration = HydrationMetrics(
        waterMl = waterMl,
      ),
      glucose = GlucoseMetrics(
        fastingMgDl = glucoseValues.minOrNull() ?: 0.0,
        avgMgDl = glucoseValues.averageOrZero(),
        maxMgDl = glucoseValues.maxOrNull() ?: 0.0,
      ),
      mindfulness = MindfulnessMetrics(
        mindfulMinutes = 0,
        meditationMinutes = 0,
      ),
      reproductiveHealth = ReproductiveHealthMetrics(),
      samples = SampleBuckets(
        workouts = workouts,
        heartRateSeries = heartRateSeries.sortedBy { it.atIso }.takeLast(240),
        spo2Series = spo2Series.sortedBy { it.atIso }.takeLast(240),
        glucoseSeries = glucoseSeries.sortedBy { it.atIso }.takeLast(120),
        bloodPressureSeries = bloodPressureSeries.sortedBy { it.atIso }.takeLast(120),
        sleepSessions = sleepSessionSamples.sortedBy { it.startIso },
        sleepStageSeries = sleepStageSamples.sortedBy { it.startIso },
      ),
      sync = SyncMetadata(
        sdkLinked = true,
        permissionsGranted = missingCore.isEmpty(),
        recordTypesAttempted = attempted.distinct(),
        recordTypesSucceeded = succeeded.distinct(),
        warnings = warnings,
      ),
    )
  }

  private suspend inline fun <reified T : Record> readIfPermitted(
    client: HealthConnectClient,
    range: TimeRangeFilter,
    label: String,
    permission: String,
    grantedPermissions: Set<String>,
    attempted: MutableList<String>,
    succeeded: MutableList<String>,
    warnings: MutableList<String>,
    warnIfMissing: Boolean = true,
    suppressForegroundRequirementWarning: Boolean = false,
  ): List<T> {
    if (!grantedPermissions.contains(permission)) {
      if (warnIfMissing) {
        warnings += "$label skipped: permission not granted"
      }
      return emptyList()
    }
    return readSafe(
      client,
      range,
      label,
      attempted,
      succeeded,
      warnings,
      suppressForegroundRequirementWarning = suppressForegroundRequirementWarning
    )
  }

  private suspend inline fun <reified T : Record> readSafe(
    client: HealthConnectClient,
    range: TimeRangeFilter,
    label: String,
    attempted: MutableList<String>,
    succeeded: MutableList<String>,
    warnings: MutableList<String>,
    suppressForegroundRequirementWarning: Boolean = false,
  ): List<T> {
    attempted += label
    return try {
      val records = client.readRecords(
        ReadRecordsRequest(
          recordType = T::class,
          timeRangeFilter = range,
        )
      ).records
      succeeded += label
      records
    } catch (error: Throwable) {
      val message = buildString {
        append(error.message.orEmpty())
        append(" ")
        append(error.toString())
        val causeMessage = error.cause?.message
        if (!causeMessage.isNullOrBlank()) {
          append(" ")
          append(causeMessage)
        }
      }
      if (
        suppressForegroundRequirementWarning &&
        message.contains("must be in foreground", ignoreCase = true)
      ) {
        return emptyList()
      }
      warnings += "$label read failed: ${error.message ?: error.javaClass.simpleName}"
      emptyList()
    }
  }

  private fun createEmptyPayload(
    date: String,
    capturedAtIso: String,
    timezone: String,
    sdkLinked: Boolean,
    permissionsGranted: Boolean,
    attempted: List<String>,
    succeeded: List<String>,
    warnings: List<String>,
  ): SamsungHealthPayload {
    return SamsungHealthPayload(
      date = date,
      capturedAtIso = capturedAtIso,
      timezone = timezone,
      source = SourceMetadata(
        provider = "health-connect",
        appVersion = "0.2.0",
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
      hydration = HydrationMetrics(
        waterMl = 0.0,
      ),
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
        recordTypesAttempted = attempted,
        recordTypesSucceeded = succeeded,
        warnings = warnings,
      ),
    )
  }

  private fun getValue(target: Any?, vararg propertyNames: String): Any? {
    if (target == null) return null

    for (propertyName in propertyNames) {
      val getterName = "get${propertyName.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }}"
      try {
        val method = target.javaClass.methods.firstOrNull { it.name == getterName && it.parameterCount == 0 }
        if (method != null) {
          method.isAccessible = true
          return method.invoke(target)
        }
      } catch (_: Throwable) {
      }
    }

    return null
  }

  private fun getDouble(target: Any?, vararg propertyNames: String): Double? {
    val value = getValue(target, *propertyNames) ?: return null
    return when (value) {
      is Number -> value.toDouble()
      else -> getUnitDouble(value)
    }
  }

  private fun getLong(target: Any?, vararg propertyNames: String): Long? {
    val value = getValue(target, *propertyNames) ?: return null
    return when (value) {
      is Number -> value.toLong()
      is String -> value.toLongOrNull()
      else -> null
    }
  }

  private fun getInt(target: Any?, vararg propertyNames: String): Int? {
    return getLong(target, *propertyNames)?.toInt()
  }

  private fun getInstant(target: Any?, vararg propertyNames: String): Instant? {
    val value = getValue(target, *propertyNames) ?: return null
    return when (value) {
      is Instant -> value
      is OffsetDateTime -> value.toInstant()
      else -> null
    }
  }

  private fun getUnitDouble(value: Any?): Double? {
    if (value == null) return null
    if (value is Number) return value.toDouble()

    val accessors = listOf(
      "getInKilocalories",
      "getInCalories",
      "getInMeters",
      "getInMillimetersOfMercury",
      "getInKilograms",
      "getInLiters",
      "getInMilliliters",
      "getInCelsius",
      "getInMilligramsPerDeciliter",
      "getValue",
    )

    for (accessor in accessors) {
      try {
        val method = value.javaClass.methods.firstOrNull { it.name == accessor && it.parameterCount == 0 }
        if (method != null) {
          val result = method.invoke(value)
          if (result is Number) return result.toDouble()
        }
      } catch (_: Throwable) {
      }
    }

    return null
  }

  private fun durationMinutes(start: Instant?, end: Instant?): Int {
    if (start == null || end == null || !end.isAfter(start)) return 0
    return Duration.between(start, end).toMinutes().coerceAtLeast(0).toInt()
  }

  private fun clipInterval(
    start: Instant,
    end: Instant,
    windowStart: Instant,
    windowEnd: Instant,
  ): TimeInterval? {
    if (!end.isAfter(start)) return null
    val clippedStart = if (start.isBefore(windowStart)) windowStart else start
    val clippedEnd = if (end.isAfter(windowEnd)) windowEnd else end
    if (!clippedEnd.isAfter(clippedStart)) return null
    return TimeInterval(clippedStart, clippedEnd)
  }

  private fun mergeIntervals(intervals: List<TimeInterval>): List<TimeInterval> {
    if (intervals.isEmpty()) return emptyList()
    val sorted = intervals.sortedBy { it.start }
    val merged = mutableListOf<TimeInterval>()

    var currentStart = sorted[0].start
    var currentEnd = sorted[0].end

    for (i in 1 until sorted.size) {
      val next = sorted[i]
      if (!next.start.isAfter(currentEnd)) {
        if (next.end.isAfter(currentEnd)) {
          currentEnd = next.end
        }
      } else {
        merged += TimeInterval(currentStart, currentEnd)
        currentStart = next.start
        currentEnd = next.end
      }
    }

    merged += TimeInterval(currentStart, currentEnd)
    return merged
  }

  private fun totalMinutes(intervals: List<TimeInterval>): Int {
    return intervals.sumOf { durationMinutes(it.start, it.end) }
  }

  private fun computeBmi(weightKg: Double): Double {
    // Height isn't currently sourced; keep BMI unset unless weight is known and user adds height mapping.
    return if (weightKg > 0) 0.0 else 0.0
  }

  private fun List<Double>.averageOrZero(): Double {
    if (isEmpty()) return 0.0
    return (sum() / size.toDouble())
      .let { value -> (value * 10.0).roundToInt() / 10.0 }
  }
}
