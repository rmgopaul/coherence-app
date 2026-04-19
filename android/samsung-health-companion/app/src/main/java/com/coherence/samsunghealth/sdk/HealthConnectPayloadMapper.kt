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
 * Reads every supported record type for a date range and maps them to
 * normalized [SamsungHealthPayload] objects, one per day.
 *
 * Two entry points:
 *  - [collectForDate] for the regular daily sync.
 *  - [collectForDateRange] for the historical backfill worker.
 *
 * Both paths go through [collectForDateRange] so there is one source
 * of truth for how Health Connect records are read and partitioned.
 * Prior versions of this class looped `collectForDate` per day inside
 * a backfill, which issued ~22 API calls *per day* and reliably tripped
 * Health Connect's rate limiter. The range path issues exactly 22 API
 * calls total — one per record type — then partitions the returned
 * records by calendar day client-side.
 *
 * All property access is compile-time typed — no reflection.
 */
class HealthConnectPayloadMapper(
  private val reader: HealthConnectReader,
) {

  private data class TimeInterval(val start: Instant, val end: Instant)

  /**
   * Convenience wrapper for the single-day daily-sync path.
   */
  suspend fun collectForDate(
    date: LocalDate,
    zone: ZoneId,
    permissionsGranted: Boolean,
  ): SamsungHealthPayload {
    return collectForDateRange(date, date, zone, permissionsGranted).first()
  }

  /**
   * Fetch every supported record type ONCE across
   * `[startDate, endDate]` (inclusive) and emit one payload per day.
   *
   * Read count is constant in the number of days requested: 22 typed
   * [HealthConnectReader.read] calls regardless of whether the range
   * is 1 day or 30. This is the rate-limit fix that makes historical
   * backfill work without blowing Health Connect's per-app quota.
   */
  suspend fun collectForDateRange(
    startDate: LocalDate,
    endDate: LocalDate,
    zone: ZoneId,
    permissionsGranted: Boolean,
  ): List<SamsungHealthPayload> {
    require(!endDate.isBefore(startDate)) {
      "endDate ($endDate) must not be before startDate ($startDate)"
    }

    val capturedAt = OffsetDateTime.now(zone)
    val rangeStart = startDate.atStartOfDay(zone).toInstant()
    val rangeEnd = endDate.plusDays(1).atStartOfDay(zone).toInstant()
    val rangeFilter = TimeRangeFilter.between(rangeStart, rangeEnd)

    // Sleep windows often start the evening before the target day.
    // Widen the SleepSessionRecord read window by 18h on the leading
    // edge so a 22:00-the-day-before bedtime is captured, then clip
    // stage intervals back into each day's window.
    val sleepRangeStart = rangeStart.minus(Duration.ofHours(18))
    val sleepRangeFilter = TimeRangeFilter.between(sleepRangeStart, rangeEnd)

    // ── 22 reads, ONE per record type, across the full range ──────────
    val stepsAll = reader.read(StepsRecord::class, rangeFilter, "steps")
    val distanceAll = reader.read(DistanceRecord::class, rangeFilter, "distance")
    val floorsAll = reader.read(
      FloorsClimbedRecord::class,
      rangeFilter,
      "floors",
      warnIfMissing = false,
    )
    val activeCalAll = reader.read(ActiveCaloriesBurnedRecord::class, rangeFilter, "active_calories")
    val totalCalAll = reader.read(TotalCaloriesBurnedRecord::class, rangeFilter, "total_calories")
    val exerciseAll = reader.read(ExerciseSessionRecord::class, rangeFilter, "exercise_sessions")
    val sleepAll = reader.read(SleepSessionRecord::class, sleepRangeFilter, "sleep_sessions")
    val heartRateAll = reader.read(HeartRateRecord::class, rangeFilter, "heart_rate")
    val restingHrAll = reader.read(RestingHeartRateRecord::class, rangeFilter, "resting_heart_rate")
    val hrvAll = reader.read(HeartRateVariabilityRmssdRecord::class, rangeFilter, "hrv")
    val respiratoryAll = reader.read(RespiratoryRateRecord::class, rangeFilter, "respiratory_rate")
    val spo2All = reader.read(OxygenSaturationRecord::class, rangeFilter, "oxygen_saturation")
    val bloodPressureAll = reader.read(BloodPressureRecord::class, rangeFilter, "blood_pressure")
    val glucoseAll = reader.read(BloodGlucoseRecord::class, rangeFilter, "blood_glucose")
    val weightAll = reader.read(WeightRecord::class, rangeFilter, "weight")
    val bodyFatAll = reader.read(
      BodyFatRecord::class,
      rangeFilter,
      "body_fat",
      suppressForegroundRequirementWarning = true,
    )
    val bodyWaterAll = reader.read(BodyWaterMassRecord::class, rangeFilter, "body_water_mass")
    val bmrAll = reader.read(BasalMetabolicRateRecord::class, rangeFilter, "bmr")
    val hydrationAll = reader.read(HydrationRecord::class, rangeFilter, "hydration")
    val nutritionAll = reader.read(NutritionRecord::class, rangeFilter, "nutrition")
    val vo2All = reader.read(Vo2MaxRecord::class, rangeFilter, "vo2", warnIfMissing = false)
    val bodyTempAll = reader.read(BodyTemperatureRecord::class, rangeFilter, "body_temperature")

    // ── Partition records per day and build payloads ─────────────────
    val payloads = mutableListOf<SamsungHealthPayload>()
    var cursor = startDate
    while (!cursor.isAfter(endDate)) {
      val dayStart = cursor.atStartOfDay(zone).toInstant()
      val dayEnd = cursor.plusDays(1).atStartOfDay(zone).toInstant()
      // Sleep window extends 18h before the day start so that a sleep
      // whose bedtime is the prior evening is still attributed to this
      // morning's wake date.
      val dayWithSleepStart = dayStart.minus(Duration.ofHours(18))

      payloads += buildPayloadForDay(
        date = cursor,
        zone = zone,
        capturedAt = capturedAt,
        permissionsGranted = permissionsGranted,
        dayStart = dayStart,
        dayEnd = dayEnd,
        // Interval-typed records: any record whose [startTime, endTime]
        // overlaps [dayStart, dayEnd) is included for this day. Sum
        // functions (steps, calories, distance) may double-count an
        // interval that spans midnight — acceptable today given Health
        // Connect sources don't emit large cross-midnight intervals,
        // and can be refined later via per-record time slicing.
        stepsRecords = stepsAll.filter { it.endTime.isAfter(dayStart) && it.startTime.isBefore(dayEnd) },
        distanceRecords = distanceAll.filter { it.endTime.isAfter(dayStart) && it.startTime.isBefore(dayEnd) },
        floorsRecords = floorsAll.filter { it.endTime.isAfter(dayStart) && it.startTime.isBefore(dayEnd) },
        activeCalRecords = activeCalAll.filter { it.endTime.isAfter(dayStart) && it.startTime.isBefore(dayEnd) },
        totalCalRecords = totalCalAll.filter { it.endTime.isAfter(dayStart) && it.startTime.isBefore(dayEnd) },
        exerciseRecords = exerciseAll.filter { it.endTime.isAfter(dayStart) && it.startTime.isBefore(dayEnd) },
        // Sleep uses the widened window so pre-midnight bedtimes land
        // on the wake-up day. computeSleepMetrics re-clips below.
        sleepRecords = sleepAll.filter { it.endTime.isAfter(dayWithSleepStart) && it.startTime.isBefore(dayEnd) },
        heartRateRecords = heartRateAll.filter { it.endTime.isAfter(dayStart) && it.startTime.isBefore(dayEnd) },
        // Instantaneous records (have a single `time` property).
        restingHrRecords = restingHrAll.filter { !it.time.isBefore(dayStart) && it.time.isBefore(dayEnd) },
        hrvRecords = hrvAll.filter { !it.time.isBefore(dayStart) && it.time.isBefore(dayEnd) },
        respiratoryRecords = respiratoryAll.filter { !it.time.isBefore(dayStart) && it.time.isBefore(dayEnd) },
        spo2Records = spo2All.filter { !it.time.isBefore(dayStart) && it.time.isBefore(dayEnd) },
        bloodPressureRecords = bloodPressureAll.filter { !it.time.isBefore(dayStart) && it.time.isBefore(dayEnd) },
        glucoseRecords = glucoseAll.filter { !it.time.isBefore(dayStart) && it.time.isBefore(dayEnd) },
        weightRecords = weightAll.filter { !it.time.isBefore(dayStart) && it.time.isBefore(dayEnd) },
        bodyFatRecords = bodyFatAll.filter { !it.time.isBefore(dayStart) && it.time.isBefore(dayEnd) },
        bodyWaterMassRecords = bodyWaterAll.filter { !it.time.isBefore(dayStart) && it.time.isBefore(dayEnd) },
        bmrRecords = bmrAll.filter { !it.time.isBefore(dayStart) && it.time.isBefore(dayEnd) },
        hydrationRecords = hydrationAll.filter { it.endTime.isAfter(dayStart) && it.startTime.isBefore(dayEnd) },
        nutritionRecords = nutritionAll.filter { it.endTime.isAfter(dayStart) && it.startTime.isBefore(dayEnd) },
        vo2Records = vo2All.filter { !it.time.isBefore(dayStart) && it.time.isBefore(dayEnd) },
        bodyTempRecords = bodyTempAll.filter { !it.time.isBefore(dayStart) && it.time.isBefore(dayEnd) },
      )
      cursor = cursor.plusDays(1)
    }

    return payloads
  }

  /**
   * Build a single day's payload from *pre-filtered* record lists.
   * No I/O happens in this function — it is a pure function of its
   * inputs, which makes it trivial to unit-test and keeps the
   * per-day cost constant once the range reads have completed.
   */
  @Suppress("LongParameterList")
  private fun buildPayloadForDay(
    date: LocalDate,
    zone: ZoneId,
    capturedAt: OffsetDateTime,
    permissionsGranted: Boolean,
    dayStart: Instant,
    dayEnd: Instant,
    stepsRecords: List<StepsRecord>,
    distanceRecords: List<DistanceRecord>,
    floorsRecords: List<FloorsClimbedRecord>,
    activeCalRecords: List<ActiveCaloriesBurnedRecord>,
    totalCalRecords: List<TotalCaloriesBurnedRecord>,
    exerciseRecords: List<ExerciseSessionRecord>,
    sleepRecords: List<SleepSessionRecord>,
    heartRateRecords: List<HeartRateRecord>,
    restingHrRecords: List<RestingHeartRateRecord>,
    hrvRecords: List<HeartRateVariabilityRmssdRecord>,
    respiratoryRecords: List<RespiratoryRateRecord>,
    spo2Records: List<OxygenSaturationRecord>,
    bloodPressureRecords: List<BloodPressureRecord>,
    glucoseRecords: List<BloodGlucoseRecord>,
    weightRecords: List<WeightRecord>,
    bodyFatRecords: List<BodyFatRecord>,
    bodyWaterMassRecords: List<BodyWaterMassRecord>,
    bmrRecords: List<BasalMetabolicRateRecord>,
    hydrationRecords: List<HydrationRecord>,
    nutritionRecords: List<NutritionRecord>,
    vo2Records: List<Vo2MaxRecord>,
    bodyTempRecords: List<BodyTemperatureRecord>,
  ): SamsungHealthPayload {
    // ── Activity ──────────────────────────────────────────────────────
    val steps = stepsRecords.sumOf { it.count }.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    val distanceMeters = distanceRecords.sumOf { it.distance.inMeters }
    val floorsClimbed = floorsRecords.sumOf { it.floors }
    val caloriesActiveKcal = activeCalRecords.sumOf { it.energy.inKilocalories }
    val caloriesTotalKcal = totalCalRecords.sumOf { it.energy.inKilocalories }

    val exerciseByType = exerciseRecords.groupBy { it.exerciseType }
    val exerciseMinutes = exerciseRecords.sumOf { durationMinutes(it.startTime, it.endTime) }

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

    // ── Cardio: only SAMPLES whose individual time falls in the day ──
    // HeartRateRecord carries many per-second samples; filtering the
    // record by interval gets us candidate records, but we still need
    // to drop any samples that fall outside [dayStart, dayEnd).
    val heartRateSeries = mutableListOf<TimedValueSample>()
    val heartRateValues = mutableListOf<Double>()
    for (record in heartRateRecords) {
      for (sample in record.samples) {
        if (sample.time.isBefore(dayStart) || !sample.time.isBefore(dayEnd)) continue
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
        activeMinutes = (exerciseMinutes +
          walkingMinutes +
          runningMinutes +
          cyclingMinutes +
          swimmingMinutes).coerceAtLeast(exerciseMinutes),
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
    // 0.3.3 — fixes the cooldown reachability bug in
    // HealthConnectReader.read(): previous versions had the
    // markRateLimited() call after the for-loop, but the loop always
    // returns from inside, making the cooldown write unreachable.
    private const val APP_VERSION = "0.3.3"
    private const val HR_SAMPLE_LIMIT = 240
    private const val CHECKIN_SAMPLE_LIMIT = 120
  }
}
