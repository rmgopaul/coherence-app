package com.coherence.samsunghealth.sdk

import android.os.Build
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
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
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

/**
 * Reads every supported record type for a single date window and maps
 * them to a normalized [SamsungHealthPayload].
 *
 * All property access is compile-time typed — no reflection. That is
 * the fix for the "broken" reads: the old reflection-based mapper
 * silently returned zeros on any property-name mismatch or library
 * upgrade.
 */
class HealthConnectPayloadMapper(
  private val reader: HealthConnectReader,
) {

  private data class TimeInterval(val start: Instant, val end: Instant)

  /**
   * Collect a payload for the local day that [date] represents in
   * [zone]. [permissionsGranted] is wired in so the output's sync
   * metadata reflects reality even when the core permission set
   * happens to include optional reads that failed.
   */
  suspend fun collectForDate(
    date: LocalDate,
    zone: ZoneId,
    permissionsGranted: Boolean,
  ): SamsungHealthPayload {
    val capturedAt = OffsetDateTime.now(zone)
    val dayStart = date.atStartOfDay(zone).toInstant()
    val dayEnd = date.plusDays(1).atStartOfDay(zone).toInstant()
    val dayRange = TimeRangeFilter.between(dayStart, dayEnd)

    // Sleep often begins the evening before the target date. Widen the
    // lookup window so a bedtime at 22:00 the previous day is captured,
    // then clip individual stage intervals back into the date's window.
    val sleepWindowStart = dayStart.minus(Duration.ofHours(18))
    val sleepRange = TimeRangeFilter.between(sleepWindowStart, dayEnd)

    val stepsRecords = reader.read(StepsRecord::class, dayRange, "steps")
    val distanceRecords = reader.read(DistanceRecord::class, dayRange, "distance")
    val floorsRecords = reader.read(
      FloorsClimbedRecord::class,
      dayRange,
      "floors",
      warnIfMissing = false,
    )
    val activeCalRecords = reader.read(ActiveCaloriesBurnedRecord::class, dayRange, "active_calories")
    val totalCalRecords = reader.read(TotalCaloriesBurnedRecord::class, dayRange, "total_calories")
    val exerciseRecords = reader.read(ExerciseSessionRecord::class, dayRange, "exercise_sessions")
    val sleepRecords = reader.read(SleepSessionRecord::class, sleepRange, "sleep_sessions")
    val heartRateRecords = reader.read(HeartRateRecord::class, dayRange, "heart_rate")
    val restingHrRecords = reader.read(RestingHeartRateRecord::class, dayRange, "resting_heart_rate")
    val hrvRecords = reader.read(HeartRateVariabilityRmssdRecord::class, dayRange, "hrv")
    val respiratoryRecords = reader.read(RespiratoryRateRecord::class, dayRange, "respiratory_rate")
    val spo2Records = reader.read(OxygenSaturationRecord::class, dayRange, "oxygen_saturation")
    val bloodPressureRecords = reader.read(BloodPressureRecord::class, dayRange, "blood_pressure")
    val glucoseRecords = reader.read(BloodGlucoseRecord::class, dayRange, "blood_glucose")
    val weightRecords = reader.read(WeightRecord::class, dayRange, "weight")
    val bodyFatRecords = reader.read(
      BodyFatRecord::class,
      dayRange,
      "body_fat",
      suppressForegroundRequirementWarning = true,
    )
    val bodyWaterMassRecords = reader.read(BodyWaterMassRecord::class, dayRange, "body_water_mass")
    val bmrRecords = reader.read(BasalMetabolicRateRecord::class, dayRange, "bmr")
    val hydrationRecords = reader.read(HydrationRecord::class, dayRange, "hydration")
    val nutritionRecords = reader.read(NutritionRecord::class, dayRange, "nutrition")
    val vo2Records = reader.read(Vo2MaxRecord::class, dayRange, "vo2", warnIfMissing = false)
    val bodyTempRecords = reader.read(BodyTemperatureRecord::class, dayRange, "body_temperature")

    // ── Activity ──────────────────────────────────────────────────────
    val steps = stepsRecords.sumOf { it.count }.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    val distanceMeters = distanceRecords.sumOf { it.distance.inMeters }
    val floorsClimbed = floorsRecords.sumOf { it.floors }
    val caloriesActiveKcal = activeCalRecords.sumOf { it.energy.inKilocalories }
    val caloriesTotalKcal = totalCalRecords.sumOf { it.energy.inKilocalories }

    val exerciseByType = exerciseRecords.groupBy { it.exerciseType }
    val exerciseMinutes = exerciseRecords.sumOf { durationMinutes(it.startTime, it.endTime) }

    // Rough per-activity splits. Exact type constants live on
    // ExerciseSessionRecord.ExerciseTypes but are many — we aggregate
    // by a handful of coarse buckets below.
    val walkingMinutes = sumDurationForTypes(
      exerciseByType,
      ExerciseSessionRecord.EXERCISE_TYPE_WALKING,
      ExerciseSessionRecord.EXERCISE_TYPE_HIKING,
    )
    val runningMinutes = sumDurationForTypes(
      exerciseByType,
      ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
      ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL,
    )
    val cyclingMinutes = sumDurationForTypes(
      exerciseByType,
      ExerciseSessionRecord.EXERCISE_TYPE_BIKING,
      ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY,
    )
    val swimmingMinutes = sumDurationForTypes(
      exerciseByType,
      ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL,
      ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER,
    )

    // ── Sleep ─────────────────────────────────────────────────────────
    val sleepResult = computeSleepMetrics(sleepRecords, dayStart, dayEnd)

    // ── Cardio series & aggregates ────────────────────────────────────
    val heartRateSeries = mutableListOf<TimedValueSample>()
    val heartRateValues = mutableListOf<Double>()
    for (record in heartRateRecords) {
      for (sample in record.samples) {
        val bpm = sample.beatsPerMinute.toDouble()
        heartRateValues += bpm
        heartRateSeries += TimedValueSample(
          atIso = sample.time.toString(),
          value = bpm,
          unit = "bpm",
        )
      }
    }

    val restingHr = restingHrRecords
      .map { it.beatsPerMinute.toDouble() }
      .averageOrZero()

    val hrvRmssd = hrvRecords
      .map { it.heartRateVariabilityMillis }
      .averageOrZero()

    val respiratoryRate = respiratoryRecords
      .map { it.rate }
      .averageOrZero()

    val vo2 = vo2Records
      .map { it.vo2MillilitersPerMinuteKilogram }
      .averageOrZero()

    // ── SpO2 / Blood pressure / Glucose series ────────────────────────
    val spo2Series = spo2Records.map { record ->
      TimedValueSample(
        atIso = record.time.toString(),
        value = record.percentage.value,
        unit = "%",
      )
    }
    val spo2Values = spo2Series.map { it.value }

    val bloodPressureSeries = bloodPressureRecords.map { record ->
      BloodPressureSample(
        atIso = record.time.toString(),
        systolicMmHg = record.systolic.inMillimetersOfMercury,
        diastolicMmHg = record.diastolic.inMillimetersOfMercury,
        // BloodPressureRecord does not carry a pulse directly in
        // Health Connect 1.1.0 — set to 0 and rely on HeartRateRecord.
        pulseBpm = 0.0,
      )
    }
    val latestBloodPressure = bloodPressureSeries.maxByOrNull { it.atIso }

    val glucoseSeries = glucoseRecords.map { record ->
      TimedValueSample(
        atIso = record.time.toString(),
        value = record.level.inMilligramsPerDeciliter,
        unit = "mg/dL",
      )
    }
    val glucoseValues = glucoseSeries.map { it.value }

    // ── Body composition (latest wins) ────────────────────────────────
    val latestWeightKg = weightRecords.maxByOrNull { it.time }?.weight?.inKilograms ?: 0.0
    val latestBodyFatPercent = bodyFatRecords.maxByOrNull { it.time }?.percentage?.value ?: 0.0
    val latestBodyWaterMassKg = bodyWaterMassRecords.maxByOrNull { it.time }?.mass?.inKilograms ?: 0.0
    val bmrKcal = bmrRecords
      .maxByOrNull { it.time }
      ?.basalMetabolicRate
      ?.inKilocaloriesPerDay
      ?: 0.0
    val bodyWaterPercent = if (latestWeightKg > 0) {
      (latestBodyWaterMassKg / latestWeightKg) * 100.0
    } else {
      0.0
    }

    // ── Hydration & nutrition ─────────────────────────────────────────
    val waterMl = hydrationRecords.sumOf { it.volume.inMilliliters }
    val caloriesIntake = nutritionRecords.sumOf { it.energy?.inKilocalories ?: 0.0 }
    val protein = nutritionRecords.sumOf { it.protein?.inGrams ?: 0.0 }
    val carbs = nutritionRecords.sumOf { it.totalCarbohydrate?.inGrams ?: 0.0 }
    val fat = nutritionRecords.sumOf { it.totalFat?.inGrams ?: 0.0 }
    val saturatedFat = nutritionRecords.sumOf { it.saturatedFat?.inGrams ?: 0.0 }
    val sugar = nutritionRecords.sumOf { it.sugar?.inGrams ?: 0.0 }
    val fiber = nutritionRecords.sumOf { it.dietaryFiber?.inGrams ?: 0.0 }
    val sodiumMg = nutritionRecords.sumOf { (it.sodium?.inGrams ?: 0.0) * 1000.0 }
    val cholesterolMg = nutritionRecords.sumOf { (it.cholesterol?.inGrams ?: 0.0) * 1000.0 }
    val caffeineMg = nutritionRecords.sumOf { (it.caffeine?.inGrams ?: 0.0) * 1000.0 }

    val latestBodyTempC = bodyTempRecords.maxByOrNull { it.time }?.temperature?.inCelsius ?: 0.0

    // ── Workouts ──────────────────────────────────────────────────────
    val workouts = exerciseRecords.map { record ->
      WorkoutSample(
        type = record.exerciseType.toString(),
        startIso = record.startTime.toString(),
        endIso = record.endTime.toString(),
        durationMinutes = durationMinutes(record.startTime, record.endTime),
        // Detailed per-workout calories/HR live on related records in
        // Health Connect rather than on the session itself. Left at 0
        // until the mapper learns to join with totalCalories / HR by
        // workout time window.
        caloriesKcal = 0.0,
        distanceMeters = 0.0,
        avgHeartRateBpm = 0.0,
        maxHeartRateBpm = 0.0,
      )
    }

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
        steps = steps,
        distanceMeters = distanceMeters,
        floorsClimbed = floorsClimbed,
        // "activeMinutes" is a broader concept than "exerciseMinutes":
        // until we compute sedentary minutes we treat "active" as a
        // superset that equals exerciseMinutes plus non-exercise
        // movement (walking/running/cycling totals that may overlap).
        activeMinutes = (exerciseMinutes +
          walkingMinutes +
          runningMinutes +
          cyclingMinutes +
          swimmingMinutes).coerceAtLeast(exerciseMinutes),
        // No Health Connect record directly exposes sedentary time;
        // leave at 0 rather than fabricating a value.
        sedentaryMinutes = 0,
        exerciseMinutes = exerciseMinutes,
        caloriesActiveKcal = caloriesActiveKcal,
        caloriesBasalKcal = bmrKcal,
        caloriesTotalKcal = if (caloriesTotalKcal > 0) caloriesTotalKcal else caloriesActiveKcal + bmrKcal,
        walkingDurationMinutes = walkingMinutes,
        runningDurationMinutes = runningMinutes,
        cyclingDurationMinutes = cyclingMinutes,
        swimmingDurationMinutes = swimmingMinutes,
        exerciseSessionCount = exerciseRecords.size,
      ),
      sleep = sleepResult.metrics,
      cardio = CardioMetrics(
        restingHeartRateBpm = restingHr,
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
        bodyTemperatureCelsius = latestBodyTempC,
      ),
      bloodPressure = BloodPressureMetrics(
        systolicMmHg = latestBloodPressure?.systolicMmHg ?: 0.0,
        diastolicMmHg = latestBloodPressure?.diastolicMmHg ?: 0.0,
        pulseBpm = latestBloodPressure?.pulseBpm ?: 0.0,
      ),
      bodyComposition = BodyCompositionMetrics(
        weightKg = latestWeightKg,
        // BMI requires a height reading, which we do not currently
        // request. Report 0 until a HeightRecord reader is added
        // rather than fabricating a value from weight alone.
        bmi = 0.0,
        bodyFatPercent = latestBodyFatPercent,
        skeletalMuscleMassKg = 0.0,
        bodyWaterPercent = bodyWaterPercent,
        basalMetabolicRateKcal = bmrKcal,
      ),
      nutrition = NutritionMetrics(
        caloriesIntakeKcal = caloriesIntake,
        proteinGrams = protein,
        carbsGrams = carbs,
        fatGrams = fat,
        saturatedFatGrams = saturatedFat,
        sugarGrams = sugar,
        fiberGrams = fiber,
        sodiumMg = sodiumMg,
        cholesterolMg = cholesterolMg,
        caffeineMg = caffeineMg,
      ),
      hydration = HydrationMetrics(waterMl = waterMl),
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
        heartRateSeries = heartRateSeries.sortedBy { it.atIso }.takeLast(HR_SAMPLE_LIMIT),
        spo2Series = spo2Series.sortedBy { it.atIso }.takeLast(HR_SAMPLE_LIMIT),
        glucoseSeries = glucoseSeries.sortedBy { it.atIso }.takeLast(CHECKIN_SAMPLE_LIMIT),
        bloodPressureSeries = bloodPressureSeries.sortedBy { it.atIso }.takeLast(CHECKIN_SAMPLE_LIMIT),
        sleepSessions = sleepResult.sessionSamples.sortedBy { it.startIso },
        sleepStageSeries = sleepResult.stageSamples.sortedBy { it.startIso },
      ),
      sync = SyncMetadata(
        sdkLinked = true,
        permissionsGranted = permissionsGranted,
        recordTypesAttempted = reader.attempted.distinct(),
        recordTypesSucceeded = reader.succeeded.distinct(),
        warnings = reader.warnings.toList(),
      ),
    )
  }

  /** Sleep-related aggregates as a tuple so the caller doesn't have to re-derive them. */
  private data class SleepAggregate(
    val metrics: SleepMetrics,
    val sessionSamples: List<SleepSessionSample>,
    val stageSamples: List<SleepStageSample>,
  )

  private fun computeSleepMetrics(
    sleepRecords: List<SleepSessionRecord>,
    windowStart: Instant,
    windowEnd: Instant,
  ): SleepAggregate {
    if (sleepRecords.isEmpty()) {
      return SleepAggregate(
        metrics = SleepMetrics(
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
        sessionSamples = emptyList(),
        stageSamples = emptyList(),
      )
    }

    val sessionIntervals = mutableListOf<TimeInterval>()
    val awakeIntervals = mutableListOf<TimeInterval>()
    val lightIntervals = mutableListOf<TimeInterval>()
    val deepIntervals = mutableListOf<TimeInterval>()
    val remIntervals = mutableListOf<TimeInterval>()
    val otherSleepIntervals = mutableListOf<TimeInterval>()
    val stageSamples = mutableListOf<SleepStageSample>()
    val sessionSamples = mutableListOf<SleepSessionSample>()

    for (record in sleepRecords) {
      val clippedSession = clipInterval(record.startTime, record.endTime, windowStart, windowEnd)
        ?: continue
      sessionIntervals += clippedSession

      for (stage in record.stages) {
        val clippedStage = clipInterval(stage.startTime, stage.endTime, windowStart, windowEnd)
          ?: continue
        val minutes = durationMinutes(clippedStage.start, clippedStage.end)
        val stageLabel = when (stage.stage) {
          SleepSessionRecord.STAGE_TYPE_AWAKE,
          SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED,
          SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> {
            awakeIntervals += clippedStage
            "awake"
          }
          SleepSessionRecord.STAGE_TYPE_LIGHT -> {
            lightIntervals += clippedStage
            "light"
          }
          SleepSessionRecord.STAGE_TYPE_DEEP -> {
            deepIntervals += clippedStage
            "deep"
          }
          SleepSessionRecord.STAGE_TYPE_REM -> {
            remIntervals += clippedStage
            "rem"
          }
          SleepSessionRecord.STAGE_TYPE_SLEEPING,
          SleepSessionRecord.STAGE_TYPE_UNKNOWN,
          -> {
            otherSleepIntervals += clippedStage
            "other"
          }
          else -> {
            otherSleepIntervals += clippedStage
            "other"
          }
        }
        stageSamples += SleepStageSample(
          stage = stageLabel,
          startIso = clippedStage.start.toString(),
          endIso = clippedStage.end.toString(),
          minutes = minutes,
        )
      }

      sessionSamples += SleepSessionSample(
        startIso = clippedSession.start.toString(),
        endIso = clippedSession.end.toString(),
        // Health Connect does not expose a sleep score. Leave at 0;
        // a downstream manual-score edit in the dashboard overrides
        // this field.
        score = 0.0,
      )
    }

    val inBedMinutes = totalMinutes(mergeIntervals(sessionIntervals))
    val awakeMinutes = totalMinutes(mergeIntervals(awakeIntervals)).coerceAtMost(inBedMinutes)
    val lightMinutes = totalMinutes(mergeIntervals(lightIntervals))
    val deepMinutes = totalMinutes(mergeIntervals(deepIntervals))
    val remMinutes = totalMinutes(mergeIntervals(remIntervals))
    val totalSleepFromStages = totalMinutes(
      mergeIntervals(lightIntervals + deepIntervals + remIntervals + otherSleepIntervals),
    )
    val totalSleepMinutes =
      if (totalSleepFromStages > 0) totalSleepFromStages
      else (inBedMinutes - awakeMinutes).coerceAtLeast(0)

    val efficiency = if (inBedMinutes > 0) {
      (totalSleepMinutes.toDouble() / inBedMinutes.toDouble()) * 100.0
    } else {
      0.0
    }

    val metrics = SleepMetrics(
      totalSleepMinutes = totalSleepMinutes,
      inBedMinutes = inBedMinutes,
      awakeMinutes = awakeMinutes,
      lightMinutes = lightMinutes,
      deepMinutes = deepMinutes,
      remMinutes = remMinutes,
      sleepOnsetLatencyMinutes = 0,
      wakeAfterSleepOnsetMinutes = awakeMinutes,
      sleepEfficiencyPercent = efficiency,
      sleepConsistencyPercent = 0.0,
      // Sleep score is *derived* from stages, not read from the record
      // (`title` is a name, not a score). Downstream can rewrite this
      // value with a manual score from the dashboard.
      sleepScore = deriveSleepScore(
        efficiencyPercent = efficiency,
        deepMinutes = deepMinutes,
        remMinutes = remMinutes,
        totalSleepMinutes = totalSleepMinutes,
      ),
      bedtimeIso = sessionSamples.minByOrNull { it.startIso }?.startIso,
      wakeTimeIso = sessionSamples.maxByOrNull { it.endIso }?.endIso,
    )

    return SleepAggregate(metrics, sessionSamples, stageSamples)
  }

  /**
   * Simple heuristic sleep score in [0, 100] derived from efficiency,
   * deep/REM balance, and total sleep. Not a clinical score — exists
   * so that a freshly-synced day with real sleep data shows a non-zero
   * value before any manual override is applied.
   */
  private fun deriveSleepScore(
    efficiencyPercent: Double,
    deepMinutes: Int,
    remMinutes: Int,
    totalSleepMinutes: Int,
  ): Double {
    if (totalSleepMinutes <= 0) return 0.0
    val effComponent = efficiencyPercent.coerceIn(0.0, 100.0) * 0.5
    val durationComponent = ((totalSleepMinutes.toDouble() / 480.0) * 100.0).coerceIn(0.0, 100.0) * 0.3
    val stageMinutes = deepMinutes + remMinutes
    val stageComponent = if (totalSleepMinutes > 0) {
      (stageMinutes.toDouble() / totalSleepMinutes.toDouble() * 100.0).coerceIn(0.0, 100.0) * 0.2
    } else {
      0.0
    }
    return ((effComponent + durationComponent + stageComponent) * 10.0).roundToInt() / 10.0
  }

  private fun sumDurationForTypes(
    grouped: Map<Int, List<ExerciseSessionRecord>>,
    vararg types: Int,
  ): Int {
    var total = 0
    for (type in types) {
      val list = grouped[type] ?: continue
      for (record in list) {
        total += durationMinutes(record.startTime, record.endTime)
      }
    }
    return total
  }

  private fun durationMinutes(start: Instant?, end: Instant?): Int {
    if (start == null || end == null || !end.isAfter(start)) return 0
    return Duration.between(start, end).toMinutes().coerceAtLeast(0L).toInt()
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
        if (next.end.isAfter(currentEnd)) currentEnd = next.end
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

  private fun List<Double>.averageOrZero(): Double {
    if (isEmpty()) return 0.0
    return ((sum() / size.toDouble()) * 10.0).roundToInt() / 10.0
  }

  companion object {
    private const val APP_VERSION = "0.3.0"
    private const val HR_SAMPLE_LIMIT = 240
    private const val CHECKIN_SAMPLE_LIMIT = 120
  }
}
