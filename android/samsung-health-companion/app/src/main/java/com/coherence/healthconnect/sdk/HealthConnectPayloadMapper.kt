package com.coherence.healthconnect.sdk

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
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.PowerRecord
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.SpeedRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.time.TimeRangeFilter
import com.coherence.healthconnect.model.ActivityMetrics
import com.coherence.healthconnect.model.BloodPressureMetrics
import com.coherence.healthconnect.model.BloodPressureSample
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
import com.coherence.healthconnect.model.SleepSessionSample
import com.coherence.healthconnect.model.SleepStageSample
import com.coherence.healthconnect.model.SourceMetadata
import com.coherence.healthconnect.model.SyncMetadata
import com.coherence.healthconnect.model.TimedValueSample
import com.coherence.healthconnect.model.WorkoutSample
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
/**
 * The mapper is stateless — callers either pass a [HealthConnectReader]
 * into [collectForDateRange] (production path) or call
 * [buildPayloadForDay] directly with pre-built [RawHealthConnectRecords]
 * (unit-test path). No shared mutable state between calls, no reader
 * field, no mocking required for the pure-mapping tests.
 */
class HealthConnectPayloadMapper {

  private data class TimeInterval(val start: Instant, val end: Instant)

  /**
   * All raw Health Connect records a single sync pulls back, grouped
   * by record type. Produced once per run by [collectForDateRange]
   * (from the reader) or directly by tests.
   *
   * [partitionForDay] returns a new instance whose every list has
   * been filtered to the `[dayStart, dayEnd)` window — the mapper's
   * per-day build step walks only those pre-filtered lists, keeping
   * [buildPayloadForDay] itself pure.
   */
  internal data class RawHealthConnectRecords(
    val steps: List<StepsRecord> = emptyList(),
    val distance: List<DistanceRecord> = emptyList(),
    val floors: List<FloorsClimbedRecord> = emptyList(),
    val activeCalories: List<ActiveCaloriesBurnedRecord> = emptyList(),
    val totalCalories: List<TotalCaloriesBurnedRecord> = emptyList(),
    val exerciseSessions: List<ExerciseSessionRecord> = emptyList(),
    val sleepSessions: List<SleepSessionRecord> = emptyList(),
    val heartRate: List<HeartRateRecord> = emptyList(),
    val restingHeartRate: List<RestingHeartRateRecord> = emptyList(),
    val hrv: List<HeartRateVariabilityRmssdRecord> = emptyList(),
    val respiratoryRate: List<RespiratoryRateRecord> = emptyList(),
    val oxygenSaturation: List<OxygenSaturationRecord> = emptyList(),
    val bloodPressure: List<BloodPressureRecord> = emptyList(),
    val bloodGlucose: List<BloodGlucoseRecord> = emptyList(),
    val weight: List<WeightRecord> = emptyList(),
    val bodyFat: List<BodyFatRecord> = emptyList(),
    val bodyWaterMass: List<BodyWaterMassRecord> = emptyList(),
    val bmr: List<BasalMetabolicRateRecord> = emptyList(),
    val hydration: List<HydrationRecord> = emptyList(),
    val nutrition: List<NutritionRecord> = emptyList(),
    val vo2Max: List<Vo2MaxRecord> = emptyList(),
    val bodyTemperature: List<BodyTemperatureRecord> = emptyList(),
    val height: List<HeightRecord> = emptyList(),
    val skinTemperature: List<SkinTemperatureRecord> = emptyList(),
    val power: List<PowerRecord> = emptyList(),
    val speed: List<SpeedRecord> = emptyList(),
  ) {
    /**
     * Return a copy of these records restricted to a single day's
     * window. Sleep uses a widened start to capture pre-midnight
     * bedtimes — [computeSleepMetrics] re-clips stage intervals back
     * into the day.
     *
     * Interval-typed records (steps, exercise, etc.) pass through if
     * `[record.startTime, record.endTime)` overlaps `[dayStart, dayEnd)`.
     * A record spanning midnight therefore appears in both neighbour
     * days — acceptable today because Health Connect sources do not
     * emit large cross-midnight intervals.
     *
     * Instantaneous records (weight, body fat, HRV, etc.) pass through
     * if `record.time` falls in `[dayStart, dayEnd)`.
     */
    fun partitionForDay(
      dayStart: Instant,
      dayEnd: Instant,
      dayWithSleepStart: Instant,
    ): RawHealthConnectRecords {
      fun <T> intervalOverlap(list: List<T>, start: (T) -> Instant, end: (T) -> Instant) =
        list.filter { end(it).isAfter(dayStart) && start(it).isBefore(dayEnd) }
      fun <T> instantaneousIn(list: List<T>, time: (T) -> Instant) =
        list.filter { !time(it).isBefore(dayStart) && time(it).isBefore(dayEnd) }

      return RawHealthConnectRecords(
        steps = intervalOverlap(steps, { it.startTime }, { it.endTime }),
        distance = intervalOverlap(distance, { it.startTime }, { it.endTime }),
        floors = intervalOverlap(floors, { it.startTime }, { it.endTime }),
        activeCalories = intervalOverlap(activeCalories, { it.startTime }, { it.endTime }),
        totalCalories = intervalOverlap(totalCalories, { it.startTime }, { it.endTime }),
        exerciseSessions = intervalOverlap(exerciseSessions, { it.startTime }, { it.endTime }),
        // Sleep uses the widened window so pre-midnight bedtimes land
        // on the wake-up day. computeSleepMetrics re-clips below.
        sleepSessions = sleepSessions.filter {
          it.endTime.isAfter(dayWithSleepStart) && it.startTime.isBefore(dayEnd)
        },
        heartRate = intervalOverlap(heartRate, { it.startTime }, { it.endTime }),
        restingHeartRate = instantaneousIn(restingHeartRate) { it.time },
        hrv = instantaneousIn(hrv) { it.time },
        respiratoryRate = instantaneousIn(respiratoryRate) { it.time },
        oxygenSaturation = instantaneousIn(oxygenSaturation) { it.time },
        bloodPressure = instantaneousIn(bloodPressure) { it.time },
        bloodGlucose = instantaneousIn(bloodGlucose) { it.time },
        weight = instantaneousIn(weight) { it.time },
        bodyFat = instantaneousIn(bodyFat) { it.time },
        bodyWaterMass = instantaneousIn(bodyWaterMass) { it.time },
        bmr = instantaneousIn(bmr) { it.time },
        hydration = intervalOverlap(hydration, { it.startTime }, { it.endTime }),
        nutrition = intervalOverlap(nutrition, { it.startTime }, { it.endTime }),
        vo2Max = instantaneousIn(vo2Max) { it.time },
        bodyTemperature = instantaneousIn(bodyTemperature) { it.time },
        height = instantaneousIn(height) { it.time },
        skinTemperature = intervalOverlap(skinTemperature, { it.startTime }, { it.endTime }),
        power = intervalOverlap(power, { it.startTime }, { it.endTime }),
        speed = intervalOverlap(speed, { it.startTime }, { it.endTime }),
      )
    }
  }

  /**
   * Sync-run bookkeeping — what the reader attempted, what succeeded,
   * and any warnings to surface on the payload. Forwarded as-is to
   * [SyncMetadata].
   */
  internal data class SyncLog(
    val attempted: List<String> = emptyList(),
    val succeeded: List<String> = emptyList(),
    val warnings: List<String> = emptyList(),
  )

  /**
   * Convenience wrapper for the single-day daily-sync path.
   */
  suspend fun collectForDate(
    reader: HealthConnectReader,
    date: LocalDate,
    zone: ZoneId,
    permissionsGranted: Boolean,
  ): SamsungHealthPayload {
    return collectForDateRange(reader, date, date, zone, permissionsGranted).first()
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
    reader: HealthConnectReader,
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
    val allRecords = RawHealthConnectRecords(
      steps = reader.read(StepsRecord::class, rangeFilter, "steps"),
      distance = reader.read(DistanceRecord::class, rangeFilter, "distance"),
      floors = reader.read(
        FloorsClimbedRecord::class,
        rangeFilter,
        "floors",
        warnIfMissing = false,
      ),
      activeCalories = reader.read(ActiveCaloriesBurnedRecord::class, rangeFilter, "active_calories"),
      totalCalories = reader.read(TotalCaloriesBurnedRecord::class, rangeFilter, "total_calories"),
      exerciseSessions = reader.read(ExerciseSessionRecord::class, rangeFilter, "exercise_sessions"),
      sleepSessions = reader.read(SleepSessionRecord::class, sleepRangeFilter, "sleep_sessions"),
      heartRate = reader.read(HeartRateRecord::class, rangeFilter, "heart_rate"),
      restingHeartRate = reader.read(RestingHeartRateRecord::class, rangeFilter, "resting_heart_rate"),
      hrv = reader.read(HeartRateVariabilityRmssdRecord::class, rangeFilter, "hrv"),
      respiratoryRate = reader.read(RespiratoryRateRecord::class, rangeFilter, "respiratory_rate"),
      oxygenSaturation = reader.read(OxygenSaturationRecord::class, rangeFilter, "oxygen_saturation"),
      bloodPressure = reader.read(BloodPressureRecord::class, rangeFilter, "blood_pressure"),
      bloodGlucose = reader.read(BloodGlucoseRecord::class, rangeFilter, "blood_glucose"),
      weight = reader.read(WeightRecord::class, rangeFilter, "weight"),
      bodyFat = reader.read(
        BodyFatRecord::class,
        rangeFilter,
        "body_fat",
        suppressForegroundRequirementWarning = true,
      ),
      bodyWaterMass = reader.read(BodyWaterMassRecord::class, rangeFilter, "body_water_mass"),
      bmr = reader.read(BasalMetabolicRateRecord::class, rangeFilter, "bmr"),
      hydration = reader.read(HydrationRecord::class, rangeFilter, "hydration"),
      nutrition = reader.read(NutritionRecord::class, rangeFilter, "nutrition"),
      vo2Max = reader.read(Vo2MaxRecord::class, rangeFilter, "vo2", warnIfMissing = false),
      bodyTemperature = reader.read(BodyTemperatureRecord::class, rangeFilter, "body_temperature"),
      height = reader.read(HeightRecord::class, rangeFilter, "height", warnIfMissing = false),
      skinTemperature = reader.read(
        SkinTemperatureRecord::class,
        rangeFilter,
        "skin_temperature",
        warnIfMissing = false,
      ),
      power = reader.read(PowerRecord::class, rangeFilter, "power", warnIfMissing = false),
      speed = reader.read(SpeedRecord::class, rangeFilter, "speed", warnIfMissing = false),
    )

    val syncLog = SyncLog(
      attempted = reader.attempted.toList(),
      succeeded = reader.succeeded.toList(),
      warnings = reader.warnings.toList(),
    )

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
        records = allRecords.partitionForDay(dayStart, dayEnd, dayWithSleepStart),
        syncLog = syncLog,
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
   *
   * Visibility: `internal` so the JVM unit test in the same Gradle
   * module (`app/src/test`) can call this directly, without needing
   * to stand up a Health Connect client or a reader mock.
   *
   * [records] must already be restricted to the `[dayStart, dayEnd)`
   * window (for interval-typed records; sleep uses a widened window).
   * [RawHealthConnectRecords.partitionForDay] is the canonical way
   * to produce that from a range-scoped read.
   */
  internal fun buildPayloadForDay(
    date: LocalDate,
    zone: ZoneId,
    capturedAt: OffsetDateTime,
    permissionsGranted: Boolean,
    dayStart: Instant,
    dayEnd: Instant,
    records: RawHealthConnectRecords,
    syncLog: SyncLog,
  ): SamsungHealthPayload {
    // Destructure the records struct once so the body below reads
    // the same as it did pre-refactor — no logic change, only the
    // boundary.
    val stepsRecords = records.steps
    val distanceRecords = records.distance
    val floorsRecords = records.floors
    val activeCalRecords = records.activeCalories
    val totalCalRecords = records.totalCalories
    val exerciseRecords = records.exerciseSessions
    val sleepRecords = records.sleepSessions
    val heartRateRecords = records.heartRate
    val restingHrRecords = records.restingHeartRate
    val hrvRecords = records.hrv
    val respiratoryRecords = records.respiratoryRate
    val spo2Records = records.oxygenSaturation
    val bloodPressureRecords = records.bloodPressure
    val glucoseRecords = records.bloodGlucose
    val weightRecords = records.weight
    val bodyFatRecords = records.bodyFat
    val bodyWaterMassRecords = records.bodyWaterMass
    val bmrRecords = records.bmr
    val hydrationRecords = records.hydration
    val nutritionRecords = records.nutrition
    val vo2Records = records.vo2Max
    val bodyTempRecords = records.bodyTemperature
    val heightRecords = records.height
    val skinTempRecords = records.skinTemperature
    val powerRecords = records.power
    val speedRecords = records.speed

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

    // Height is instantaneous and rarely changes, so the latest read
    // within the day window is authoritative. Used to derive BMI.
    val latestHeightMeters = heightRecords.maxByOrNull { it.time }?.height?.inMeters ?: 0.0
    val bmiDerived = if (latestWeightKg > 0 && latestHeightMeters > 0) {
      val value = latestWeightKg / (latestHeightMeters * latestHeightMeters)
      ((value * 10.0).roundToInt() / 10.0) // 1dp
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

    // Skin temperature: SkinTemperatureRecord stores a baseline + a
    // list of deltas. Average the absolute skin temperature by adding
    // each delta to its parent baseline when both are present. If the
    // record only has a baseline, that's our best estimate.
    val skinTempValues = skinTempRecords.flatMap { record ->
      val baseline = record.baseline?.inCelsius
      if (baseline == null) return@flatMap emptyList<Double>()
      if (record.deltas.isEmpty()) return@flatMap listOf(baseline)
      record.deltas.map { baseline + it.delta.inCelsius }
    }
    val latestSkinTempC = skinTempValues.averageOrZero()

    // Power samples come in as a list inside each record. Filter
    // samples to the day's window so a record spanning midnight
    // only contributes samples in the correct day. Samsung Health
    // writes these for cycling workouts + occasionally treadmill.
    val powerWatts = powerRecords.flatMap { record ->
      record.samples.mapNotNull { sample ->
        if (sample.time.isBefore(dayStart) || !sample.time.isBefore(dayEnd)) null
        else sample.power.inWatts
      }
    }
    val peakPowerWatts = powerWatts.maxOrNull() ?: 0.0
    val averagePowerWatts = powerWatts.averageOrZero()

    // Speed samples: same pattern. Samsung Health writes these for
    // running + cycling; useful for pace computation server-side.
    val speedMps = speedRecords.flatMap { record ->
      record.samples.mapNotNull { sample ->
        if (sample.time.isBefore(dayStart) || !sample.time.isBefore(dayEnd)) null
        else sample.speed.inMetersPerSecond
      }
    }
    val peakSpeedMps = speedMps.maxOrNull() ?: 0.0
    val averageSpeedMps = speedMps.averageOrZero()

    // ── Workouts (joined with calories + HR by time window) ──────────
    // ExerciseSessionRecord carries only metadata — calories and HR
    // live on other record types. For each session we window-join to
    // the records that overlap its [startTime, endTime]. Calories +
    // distance use the session window on their *interval* records
    // (overlap rule); HR uses per-sample filtering since those are
    // point-in-time.
    val workouts = exerciseRecords.map { record ->
      val sessionStart = record.startTime
      val sessionEnd = record.endTime

      val sessionCalories = activeCalRecords
        .filter { it.endTime.isAfter(sessionStart) && it.startTime.isBefore(sessionEnd) }
        .sumOf { it.energy.inKilocalories }
      val sessionDistance = distanceRecords
        .filter { it.endTime.isAfter(sessionStart) && it.startTime.isBefore(sessionEnd) }
        .sumOf { it.distance.inMeters }

      val sessionHr = heartRateRecords
        .filter { it.endTime.isAfter(sessionStart) && it.startTime.isBefore(sessionEnd) }
        .flatMap { rec ->
          rec.samples.mapNotNull { s ->
            if (s.time.isBefore(sessionStart) || !s.time.isBefore(sessionEnd)) null
            else s.beatsPerMinute.toDouble()
          }
        }
      val avgHr = sessionHr.averageOrZero()
      val maxHr = sessionHr.maxOrNull() ?: 0.0

      WorkoutSample(
        type = record.exerciseType.toString(),
        startIso = record.startTime.toString(),
        endIso = record.endTime.toString(),
        durationMinutes = durationMinutes(record.startTime, record.endTime),
        caloriesKcal = sessionCalories,
        distanceMeters = sessionDistance,
        avgHeartRateBpm = avgHr,
        maxHeartRateBpm = maxHr,
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
        peakPowerWatts = peakPowerWatts,
        averagePowerWatts = averagePowerWatts,
        peakSpeedMps = peakSpeedMps,
        averageSpeedMps = averageSpeedMps,
      ),
      oxygenAndTemperature = OxygenAndTemperatureMetrics(
        spo2AvgPercent = spo2Values.averageOrZero(),
        spo2MinPercent = spo2Values.minOrNull() ?: 0.0,
        skinTemperatureCelsius = latestSkinTempC,
        bodyTemperatureCelsius = latestBodyTempC,
      ),
      bloodPressure = BloodPressureMetrics(
        systolicMmHg = latestBloodPressure?.systolicMmHg ?: 0.0,
        diastolicMmHg = latestBloodPressure?.diastolicMmHg ?: 0.0,
        pulseBpm = latestBloodPressure?.pulseBpm ?: 0.0,
      ),
      bodyComposition = BodyCompositionMetrics(
        weightKg = latestWeightKg,
        bmi = bmiDerived,
        bodyFatPercent = latestBodyFatPercent,
        skeletalMuscleMassKg = 0.0,
        bodyWaterPercent = bodyWaterPercent,
        basalMetabolicRateKcal = bmrKcal,
        heightMeters = latestHeightMeters,
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
        recordTypesAttempted = syncLog.attempted.distinct(),
        recordTypesSucceeded = syncLog.succeeded.distinct(),
        warnings = syncLog.warnings,
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
    // 0.4.0 — feature bump:
    //   - 60-min cadence + onResume debounce (was 15-min, quota
    //     saturation)
    //   - HeightRecord, SkinTemperatureRecord, PowerRecord,
    //     SpeedRecord support
    //   - BMI derivation from weight + height
    //   - Workouts now carry joined calories + HR per session
    //   - WHOOP dataOrigin filter (records from com.whoop.android
    //     are dropped so HC stays WHOOP-free; WHOOP keeps its own
    //     server-side OAuth pipeline)
    //   - SYNC_KEY moved from build.gradle.kts to local.properties
    // 0.5.1 — refactor: collapsed buildPayloadForDay's 28-param
    // signature to 8 via RawHealthConnectRecords + SyncLog structs.
    // Mapper is now stateless (no reader field); dropped mockk test
    // dependency.
    // 0.5.2 — test: HealthConnectReader now has 11 JVM unit tests
    // covering permission gating, retry/backoff, cooldown marking,
    // foreground-error suppression, WHOOP filter, and pagination.
    // Extracted RateLimitCooldownSink + HealthConnectRecordSource
    // interfaces so the reader depends on what it uses.
    // 0.5.3 — class renames within the healthconnect package so the
    // names match what the code actually does:
    //   SamsungHealthDataSdkRepository  -> HealthConnectRepository
    //   SamsungHealthRepository (iface) -> HealthConnectPayloadSource
    //   SamsungHealthSyncWorker         -> HealthConnectPeriodicSyncWorker
    // DB columns, tRPC provider slug "samsung-health", WorkManager
    // unique-work name strings, and the SamsungHealthPayload wire
    // contract are unchanged — renaming those would require
    // coordinated DB + server + installed-device migrations.
    private const val APP_VERSION = "0.5.3"
    private const val HR_SAMPLE_LIMIT = 240
    private const val CHECKIN_SAMPLE_LIMIT = 120
  }
}
