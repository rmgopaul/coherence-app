package com.coherence.healthconnect.sdk

import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import com.coherence.healthconnect.sdk.HealthConnectPayloadMapper.RawHealthConnectRecords
import com.coherence.healthconnect.sdk.HealthConnectPayloadMapper.SyncLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * JVM unit tests for [HealthConnectPayloadMapper.buildPayloadForDay].
 *
 * These run on the host JVM (not an Android device or emulator), so
 * they're fast and always executed in CI. Scope is the *pure*
 * computational layer of the mapper — taking already-filtered record
 * lists and producing a [com.coherence.healthconnect.model.SamsungHealthPayload].
 *
 * The mapper is stateless (no reader field, no mutable state), which
 * means these tests instantiate `HealthConnectPayloadMapper()` directly
 * with no test doubles needed. No `mockk`, no fake `HealthConnectClient`.
 *
 * What's NOT tested here:
 *  - The [HealthConnectReader] retry / rate-limit cooldown loop.
 *    Uses a live `HealthConnectClient` — verified on-device instead
 *    (see 2026-04-19 session postmortem entry about
 *    `HealthConnectReader.read` cooldown unreachable-code bug).
 *  - The WHOOP `dataOrigin.packageName` filter. Needs `Metadata`
 *    with a configurable `DataOrigin`, which the 1.1.0 Health Connect
 *    client library only exposes through an internal constructor.
 *    Reachable via reflection, but we verify it on-device via adb
 *    logcat looking for "dropped N records from excluded sources".
 *  - The `collectForDateRange` range-read step (which calls into the
 *    reader). The per-day partitioning logic in
 *    [RawHealthConnectRecords.partitionForDay] is exercised
 *    indirectly by the `buildPayloadForDay` tests below whose input
 *    records have already been scoped to a day.
 */
class HealthConnectPayloadMapperTest {

  private val zone: ZoneId = ZoneId.of("America/Chicago")
  private val date: LocalDate = LocalDate.of(2026, 4, 15)
  private val dayStart: Instant = date.atStartOfDay(zone).toInstant()
  private val dayEnd: Instant = date.plusDays(1).atStartOfDay(zone).toInstant()
  private val zoneOffset: ZoneOffset =
    zone.rules.getOffset(dayStart)
  private val capturedAt: OffsetDateTime = OffsetDateTime.ofInstant(dayStart, zone)

  private val metadata: Metadata = Metadata.manualEntry()

  private val mapper = HealthConnectPayloadMapper()

  // ──────────────────────────────────────────────────────────────────
  // Record-building helpers
  // ──────────────────────────────────────────────────────────────────

  private fun instant(hour: Int, minute: Int = 0): Instant =
    date.atStartOfDay(zone).plusHours(hour.toLong()).plusMinutes(minute.toLong()).toInstant()

  private fun steps(hourStart: Int, hourEnd: Int, count: Long): StepsRecord =
    StepsRecord(
      startTime = instant(hourStart),
      startZoneOffset = zoneOffset,
      endTime = instant(hourEnd),
      endZoneOffset = zoneOffset,
      count = count,
      metadata = metadata,
    )

  private fun distance(hourStart: Int, hourEnd: Int, meters: Double): DistanceRecord =
    DistanceRecord(
      startTime = instant(hourStart),
      startZoneOffset = zoneOffset,
      endTime = instant(hourEnd),
      endZoneOffset = zoneOffset,
      distance = Length.meters(meters),
      metadata = metadata,
    )

  private fun activeCalories(hourStart: Int, hourEnd: Int, kcal: Double): ActiveCaloriesBurnedRecord =
    ActiveCaloriesBurnedRecord(
      startTime = instant(hourStart),
      startZoneOffset = zoneOffset,
      endTime = instant(hourEnd),
      endZoneOffset = zoneOffset,
      energy = Energy.kilocalories(kcal),
      metadata = metadata,
    )

  private fun heartRate(hourStart: Int, hourEnd: Int, bpms: List<Pair<Int, Long>>): HeartRateRecord =
    HeartRateRecord(
      startTime = instant(hourStart),
      startZoneOffset = zoneOffset,
      endTime = instant(hourEnd),
      endZoneOffset = zoneOffset,
      samples = bpms.map { (minuteOfDay, bpm) ->
        HeartRateRecord.Sample(time = instant(0, minuteOfDay), beatsPerMinute = bpm)
      },
      metadata = metadata,
    )

  private fun weight(kilograms: Double, atHour: Int = 6): WeightRecord =
    WeightRecord(
      time = instant(atHour),
      zoneOffset = zoneOffset,
      weight = Mass.kilograms(kilograms),
      metadata = metadata,
    )

  private fun height(meters: Double, atHour: Int = 6): HeightRecord =
    HeightRecord(
      time = instant(atHour),
      zoneOffset = zoneOffset,
      height = Length.meters(meters),
      metadata = metadata,
    )

  private fun exercise(
    hourStart: Int,
    hourEnd: Int,
    type: Int = ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
  ): ExerciseSessionRecord =
    ExerciseSessionRecord(
      startTime = instant(hourStart),
      startZoneOffset = zoneOffset,
      endTime = instant(hourEnd),
      endZoneOffset = zoneOffset,
      exerciseType = type,
      title = null,
      notes = null,
      metadata = metadata,
    )

  /**
   * Invoke [HealthConnectPayloadMapper.buildPayloadForDay] with the
   * given record lists. All other record types default to empty.
   */
  private fun build(
    steps: List<StepsRecord> = emptyList(),
    distance: List<DistanceRecord> = emptyList(),
    activeCalories: List<ActiveCaloriesBurnedRecord> = emptyList(),
    exerciseSessions: List<ExerciseSessionRecord> = emptyList(),
    heartRate: List<HeartRateRecord> = emptyList(),
    weight: List<WeightRecord> = emptyList(),
    height: List<HeightRecord> = emptyList(),
  ) = mapper.buildPayloadForDay(
    date = date,
    zone = zone,
    capturedAt = capturedAt,
    permissionsGranted = true,
    dayStart = dayStart,
    dayEnd = dayEnd,
    records = RawHealthConnectRecords(
      steps = steps,
      distance = distance,
      activeCalories = activeCalories,
      exerciseSessions = exerciseSessions,
      heartRate = heartRate,
      weight = weight,
      height = height,
    ),
    syncLog = SyncLog(),
  )

  // ──────────────────────────────────────────────────────────────────
  // Tests
  // ──────────────────────────────────────────────────────────────────

  @Test
  fun `empty day produces zero'd payload without crashing`() {
    val p = build()
    assertEquals(0, p.activity.steps)
    assertEquals(0.0, p.activity.distanceMeters, 0.0)
    assertEquals(0.0, p.bodyComposition.bmi, 0.0)
    assertEquals(0.0, p.cardio.averageHeartRateBpm, 0.0)
    assertTrue(p.samples.workouts.isEmpty())
    assertTrue(p.sync.permissionsGranted)
  }

  @Test
  fun `steps sum across multiple records`() {
    val p = build(steps = listOf(steps(8, 9, 1500), steps(14, 15, 2500)))
    assertEquals(4000, p.activity.steps)
  }

  @Test
  fun `distance sums in meters`() {
    val p = build(distance = listOf(distance(7, 8, 1200.0), distance(17, 18, 800.0)))
    assertEquals(2000.0, p.activity.distanceMeters, 0.1)
  }

  // ── BMI derivation (previously always 0 — see audit Tier 1.2a) ────

  @Test
  fun `BMI derives from height plus weight`() {
    // 1.75 m, 70 kg → 22.86 → rounded to 1 dp = 22.9
    val p = build(
      weight = listOf(weight(70.0)),
      height = listOf(height(1.75)),
    )
    assertEquals(22.9, p.bodyComposition.bmi, 0.01)
    assertEquals(70.0, p.bodyComposition.weightKg, 0.01)
    assertEquals(1.75, p.bodyComposition.heightMeters, 0.01)
  }

  @Test
  fun `BMI stays at zero when height is missing`() {
    // Preserves the pre-HeightRecord fallback behaviour so consumers
    // that look for `bmi == 0` to mean "unknown" keep working.
    val p = build(weight = listOf(weight(70.0)))
    assertEquals(0.0, p.bodyComposition.bmi, 0.0)
    assertEquals(70.0, p.bodyComposition.weightKg, 0.01)
    assertEquals(0.0, p.bodyComposition.heightMeters, 0.0)
  }

  @Test
  fun `BMI uses the latest weight and height inside the day`() {
    val p = build(
      weight = listOf(weight(80.0, atHour = 6), weight(70.0, atHour = 20)),
      height = listOf(height(1.80, atHour = 6), height(1.75, atHour = 20)),
    )
    // Should use the later readings: 70 / 1.75² = 22.86 → 22.9
    assertEquals(22.9, p.bodyComposition.bmi, 0.01)
  }

  // ── Workout calories + HR join (audit Tier 1.3) ───────────────────

  @Test
  fun `workout session carries summed calories from overlapping records`() {
    val session = exercise(hourStart = 7, hourEnd = 8)
    val cals = listOf(
      activeCalories(7, 8, 200.0), // fully inside session → 200
      activeCalories(8, 9, 150.0), // starts at session end → should NOT overlap
                                    // (endTime.isAfter(sessionStart) is true,
                                    //  startTime.isBefore(sessionEnd) is FALSE
                                    //  because 8:00 is NOT before 8:00)
    )
    val p = build(exerciseSessions = listOf(session), activeCalories = cals)
    val workout = p.samples.workouts.single()
    assertEquals(200.0, workout.caloriesKcal, 0.1)
  }

  @Test
  fun `workout session carries distance from overlapping records`() {
    val session = exercise(hourStart = 7, hourEnd = 8)
    val distances = listOf(
      distance(7, 8, 5000.0), // fully inside
    )
    val p = build(exerciseSessions = listOf(session), distance = distances)
    val workout = p.samples.workouts.single()
    assertEquals(5000.0, workout.distanceMeters, 0.1)
  }

  @Test
  fun `workout session computes avg and max HR from samples inside its window`() {
    val session = exercise(hourStart = 7, hourEnd = 8)
    // HR record spanning 6:30 → 8:30. Samples at 7:05 (140),
    // 7:30 (160), 7:55 (150). All three fall inside the session
    // window and should be used.
    val hr = heartRate(
      hourStart = 6,
      hourEnd = 9,
      bpms = listOf(
        (7 * 60 + 5) to 140L,
        (7 * 60 + 30) to 160L,
        (7 * 60 + 55) to 150L,
      ),
    )
    val p = build(
      exerciseSessions = listOf(session),
      heartRate = listOf(hr),
    )
    val workout = p.samples.workouts.single()
    // avg = (140 + 160 + 150) / 3 = 150.0
    assertEquals(150.0, workout.avgHeartRateBpm, 0.5)
    assertEquals(160.0, workout.maxHeartRateBpm, 0.1)
  }

  @Test
  fun `workout session excludes HR samples outside its time window`() {
    val session = exercise(hourStart = 10, hourEnd = 11)
    // HR record spans much wider (6:00-22:00) with samples both
    // inside and outside the session window. Only the inside
    // samples should contribute.
    val hr = heartRate(
      hourStart = 6,
      hourEnd = 22,
      bpms = listOf(
        (7 * 60) to 80L,       // before session → excluded
        (10 * 60 + 15) to 155L, // inside → included
        (10 * 60 + 45) to 165L, // inside → included
        (11 * 60 + 10) to 90L,  // after session → excluded
      ),
    )
    val p = build(
      exerciseSessions = listOf(session),
      heartRate = listOf(hr),
    )
    val workout = p.samples.workouts.single()
    assertEquals(160.0, workout.avgHeartRateBpm, 0.5)
    assertEquals(165.0, workout.maxHeartRateBpm, 0.1)
  }

  // ── Exercise type splits (audit Tier 1.2 — no longer always 0) ───

  @Test
  fun `walking + running sessions split by type`() {
    val walk = exercise(
      hourStart = 7, hourEnd = 8,
      type = ExerciseSessionRecord.EXERCISE_TYPE_WALKING,
    )
    val run = exercise(
      hourStart = 17, hourEnd = 18,
      type = ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
    )
    val p = build(exerciseSessions = listOf(walk, run))
    assertEquals(60, p.activity.walkingDurationMinutes)
    assertEquals(60, p.activity.runningDurationMinutes)
    assertEquals(0, p.activity.cyclingDurationMinutes)
    assertEquals(0, p.activity.swimmingDurationMinutes)
    assertEquals(120, p.activity.exerciseMinutes)
    assertEquals(2, p.activity.exerciseSessionCount)
  }

  // ── HR aggregate sanity ──────────────────────────────────────────

  @Test
  fun `cardio averages aggregate across records`() {
    val hr1 = heartRate(hourStart = 6, hourEnd = 7, bpms = listOf((6 * 60 + 30) to 60L))
    val hr2 = heartRate(hourStart = 18, hourEnd = 19, bpms = listOf((18 * 60 + 30) to 80L))
    val p = build(heartRate = listOf(hr1, hr2))
    assertEquals(70.0, p.cardio.averageHeartRateBpm, 0.1)
    assertEquals(60.0, p.cardio.minHeartRateBpm, 0.1)
    assertEquals(80.0, p.cardio.maxHeartRateBpm, 0.1)
  }
}
