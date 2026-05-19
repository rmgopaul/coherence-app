package com.coherence.samsunghealth.sdk

import android.app.Activity
import android.content.Context
import android.os.Build
import android.util.Log
import com.coherence.samsunghealth.BuildConfig
import com.coherence.samsunghealth.model.ActivityMetrics
import com.coherence.samsunghealth.model.CardioMetrics
import com.coherence.samsunghealth.model.SamsungHealthPayload
import com.coherence.samsunghealth.model.SleepMetrics
import com.coherence.samsunghealth.model.SourceMetadata
import com.coherence.samsunghealth.model.SyncMetadata
import com.samsung.android.sdk.health.data.HealthDataService
import com.samsung.android.sdk.health.data.HealthDataStore
import com.samsung.android.sdk.health.data.data.HealthDataPoint
import com.samsung.android.sdk.health.data.permission.AccessType
import com.samsung.android.sdk.health.data.permission.Permission
import com.samsung.android.sdk.health.data.request.DataType
import com.samsung.android.sdk.health.data.request.DataTypes
import com.samsung.android.sdk.health.data.request.LocalDateFilter
import com.samsung.android.sdk.health.data.request.LocalTimeFilter
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * Reads the two Samsung-proprietary scores via the Samsung Health
 * Data SDK and assembles a [SamsungHealthPayload] for the existing
 * server webhook.
 *
 * All SDK symbols below were confirmed by `javap`-ing
 * `samsung-health-data-api-1.1.0.aar`'s `classes.jar` — not from
 * docs. The confirmed signatures (quoted in the PR description):
 *
 *  - `HealthDataService.getStore(Context): HealthDataStore`
 *    (Kotlin `object` with a `@JvmStatic` accessor).
 *  - `HealthDataStore.requestPermissions(Set<Permission>, Activity)`
 *    `: Set<Permission>` — `suspend` in Kotlin (the decompiled
 *    signature carries a trailing `Continuation`).
 *  - `HealthDataStore.getGrantedPermissions(Set<Permission>)`
 *    `: Set<Permission>` — `suspend`.
 *  - `HealthDataStore.readData(ReadDataRequest<T>)`
 *    `: DataResponse<T>` — `suspend`; `DataResponse.getDataList()`
 *    is `List<T>`.
 *  - `Permission.of(DataType, AccessType): Permission` (static).
 *  - `DataTypes.SLEEP` is a `DataType.SleepType`; its
 *    `getReadDataRequestBuilder()` returns a
 *    `ReadDataRequest.DualTimeBuilder<HealthDataPoint>` →
 *    `.setLocalTimeFilter(LocalTimeFilter.of(...))`.
 *  - `DataTypes.ENERGY_SCORE` is a `DataType.EnergyScoreType`; its
 *    `getReadDataRequestBuilder()` returns a
 *    `ReadDataRequest.LocalDateBuilder<HealthDataPoint>` →
 *    `.setLocalDateFilter(LocalDateFilter.of(...))`.
 *  - `DataType.SleepType.SLEEP_SCORE` is `Field<Integer>`;
 *    `DataType.EnergyScoreType.ENERGY_SCORE` is `Field<Float>`;
 *    both read via `HealthDataPoint.getValue(field)`.
 */
class SamsungHealthReader(private val appContext: Context) {

  private val store: HealthDataStore by lazy {
    // `HealthDataService` is a Kotlin `object`; the no-CoroutineScope
    // overload is exposed as a JvmStatic, so this resolves to
    // `HealthDataService.INSTANCE.getStore(context)`.
    HealthDataService.getStore(appContext)
  }

  /** The two permissions this companion needs — read-only. */
  fun requiredPermissions(): Set<Permission> = setOf(
    Permission.of(DataTypes.SLEEP, AccessType.READ),
    Permission.of(DataTypes.ENERGY_SCORE, AccessType.READ),
  )

  /**
   * @return the subset of [requiredPermissions] currently granted.
   */
  suspend fun grantedPermissions(): Set<Permission> =
    store.getGrantedPermissions(requiredPermissions())

  suspend fun hasAllPermissions(): Boolean =
    grantedPermissions().containsAll(requiredPermissions())

  /**
   * Launches the Samsung Health permission sheet. Must be called
   * with a foreground [Activity] (the SDK starts an Activity-result
   * flow). Returns the granted set after the user responds.
   */
  suspend fun requestPermissions(activity: Activity): Set<Permission> =
    store.requestPermissions(requiredPermissions(), activity)

  /**
   * Reads today's Sleep Score + Energy Score and builds the
   * webhook payload. Each read is independently guarded so a
   * permission gap or empty dataset for one score degrades to a
   * warning instead of failing the whole sync (mirrors the HC
   * companion's per-record-type resilience).
   *
   * The "read changes since last sync" capability the task calls
   * out is satisfied here by a bounded same-day window read: both
   * data types are low-cardinality (one Sleep Score + one Energy
   * Score per day), so a windowed `readData` for [date] is the
   * correct incremental unit — there is no benefit to a
   * `readChanges` cursor for a single daily value, and a windowed
   * read is robust to the SDK's change-token expiry. See
   * [readChangedSince] for the cursor-based variant kept for
   * completeness / future multi-day backfill.
   */
  suspend fun buildTodayPayload(date: LocalDate = LocalDate.now()): SamsungHealthPayload {
    val zone = ZoneId.systemDefault()
    val warnings = mutableListOf<String>()
    val attempted = mutableListOf<String>()
    val succeeded = mutableListOf<String>()

    var sleepScore = 0.0
    var energyScore = 0.0
    var anyPermission = false

    val granted = runCatching { grantedPermissions() }.getOrElse {
      warnings += "permission check failed: ${it.message ?: it.javaClass.simpleName}"
      emptySet()
    }
    anyPermission = granted.isNotEmpty()

    // ---- Sleep Score (DataTypes.SLEEP, DualTimeBuilder) ----
    attempted += DataTypes.SLEEP.name
    if (granted.any { it.dataType.name == DataTypes.SLEEP.name }) {
      runCatching {
        // Sleep sessions are anchored to the night that *ends* on
        // `date`; widen the window to the prior 18:00 → today 18:00
        // so a session that started before midnight is captured.
        val start = date.minusDays(1).atTime(LocalTime.of(18, 0))
        val end = date.atTime(LocalTime.of(18, 0))
        readSleepScore(start, end)
      }.onSuccess { value ->
        if (value != null) {
          sleepScore = value.toDouble()
          succeeded += DataTypes.SLEEP.name
        } else {
          warnings += "sleep score: no data for $date"
        }
      }.onFailure {
        warnings += "sleep score read failed: ${it.message ?: it.javaClass.simpleName}"
      }
    } else {
      warnings += "sleep score: permission not granted"
    }

    // ---- Energy Score (DataTypes.ENERGY_SCORE, LocalDateBuilder) ----
    attempted += DataTypes.ENERGY_SCORE.name
    if (granted.any { it.dataType.name == DataTypes.ENERGY_SCORE.name }) {
      runCatching {
        // ENERGY_SCORE filters by `LocalDateFilter`, which is a
        // HALF-OPEN `[start, end)` range with an EXCLUSIVE end.
        // Verified from the SDK's decompiled
        // `LocalDateFilter.Companion.of(start, end)`: it only
        // rejects `start > end`; `start == end` is accepted and
        // builds the filter with ctor flags
        // (isInclusiveStart=true, isInclusiveEnd=false). So
        // `of(date, date)` is an EMPTY window — it constructs
        // cleanly, then `readData` rejects the empty query with
        // ERR_INVALID_INPUT (1001). That was the silent
        // `energyScore=0.0` root cause on the 2026-05-19 Galaxy
        // Z Fold7 smoke test (`readData error callback (1001)`).
        // Pass the next day as the exclusive upper bound so the
        // window is exactly `[date, date+1)` = the single day.
        readEnergyScore(date, date.plusDays(1))
      }.onSuccess { value ->
        if (value != null) {
          // SDK Field is Float; server stores a rounded Int
          // (`samsungEnergyScore`). Round here so the wire value
          // already matches the column.
          energyScore = Math.round(value).toDouble()
          succeeded += DataTypes.ENERGY_SCORE.name
        } else {
          warnings += "energy score: no data for $date"
        }
      }.onFailure {
        warnings += "energy score read failed: ${it.message ?: it.javaClass.simpleName}"
      }
    } else {
      warnings += "energy score: permission not granted"
    }

    val now = ZonedDateTime.now(zone)
    return SamsungHealthPayload(
      date = date.format(DateTimeFormatter.ISO_LOCAL_DATE),
      capturedAtIso = now.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
      timezone = zone.id,
      source = SourceMetadata(
        provider = "samsung-health-data-sdk",
        appVersion = BuildConfig.VERSION_NAME,
        deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}",
        osVersion = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
      ),
      activity = ActivityMetrics(),
      sleep = SleepMetrics(sleepScore = sleepScore),
      cardio = CardioMetrics(energyScore = energyScore),
      sync = SyncMetadata(
        sdkLinked = true,
        permissionsGranted = anyPermission,
        recordTypesAttempted = attempted,
        recordTypesSucceeded = succeeded,
        warnings = warnings,
      ),
    )
  }

  /**
   * Reads the latest Sleep Score in the [start, end) local-time
   * window. `DataTypes.SLEEP` exposes a
   * `ReadDataRequest.DualTimeBuilder<HealthDataPoint>`, filtered by
   * `LocalTimeFilter`. `SleepType.SLEEP_SCORE` is `Field<Integer>`.
   */
  suspend fun readSleepScore(start: LocalDateTime, end: LocalDateTime): Int? {
    val request = DataTypes.SLEEP.readDataRequestBuilder
      .setLocalTimeFilter(LocalTimeFilter.of(start, end))
      .build()
    val response = store.readData(request)
    val points: List<HealthDataPoint> = response.dataList
    // 2026-05-19 diagnostic — the read returns SUCCESS but the
    // webhook lands sleepScore=0 even though the Samsung Health app
    // shows a real score (~90). Dump the raw SDK response shape so
    // the next on-device sync tells us the actual cause (0 points vs
    // SLEEP_SCORE null on the point vs a window/anchor mismatch)
    // instead of guessing a reader rewrite. Behaviour unchanged.
    Log.i(TAG, "readSleepScore window=[$start, $end) points=${points.size}")
    points.forEachIndexed { i, p ->
      // -1 is a log-only null sentinel (so "no score" is
      // unambiguous in logcat). The SELECTION below intentionally
      // uses getValue(...) != null, not this sentinel.
      val score = p.getValueOrDefault(DataType.SleepType.SLEEP_SCORE, -1)
      val sessions = runCatching {
        p.getValue(DataType.SleepType.SESSIONS)?.size
      }.getOrNull()
      Log.i(
        TAG,
        "  sleep[$i] start=${p.startTime} end=${p.endTime} " +
          "SLEEP_SCORE=$score sessions=$sessions",
      )
    }
    // Samsung returns MULTIPLE sleep points for a single night: the
    // scored aggregate AND duplicate/secondary-source detail records
    // whose SLEEP_SCORE is null. `points.lastOrNull()` grabbed
    // whichever happened to be last — the 2026-05-19 Galaxy Z Fold7
    // diagnostic showed sleep[0] SLEEP_SCORE=90, sleep[1]
    // SLEEP_SCORE=null, and the old code returned sleep[1] → the
    // silent "sleepScore: no data" despite the app showing 90.
    // Pick the most-recent point that actually carries a non-null
    // score (maxBy startTime over the scored points), not just the
    // last point in the list.
    return points
      .filter { it.getValue(DataType.SleepType.SLEEP_SCORE) != null }
      .maxByOrNull { it.startTime }
      ?.getValue(DataType.SleepType.SLEEP_SCORE)
  }

  /**
   * Reads the latest Energy Score in the **half-open** `[from, to)`
   * local-date range — `to` is EXCLUSIVE (this mirrors the SDK's
   * own `LocalDateFilter.of(start, end)`, whose decompiled
   * constructor flags are isInclusiveStart=true / isInclusiveEnd=
   * false). Callers reading a single day `d` must pass
   * `readEnergyScore(d, d.plusDays(1))`; `readEnergyScore(d, d)` is
   * an empty window and `readData` rejects it with
   * ERR_INVALID_INPUT (1001).
   *
   * `DataTypes.ENERGY_SCORE` exposes a
   * `ReadDataRequest.LocalDateBuilder<HealthDataPoint>`, filtered by
   * `LocalDateFilter`. `EnergyScoreType.ENERGY_SCORE` is
   * `Field<Float>`.
   */
  suspend fun readEnergyScore(from: LocalDate, to: LocalDate): Float? {
    val request = DataTypes.ENERGY_SCORE.readDataRequestBuilder
      .setLocalDateFilter(LocalDateFilter.of(from, to))
      .build()
    val response = store.readData(request)
    val points: List<HealthDataPoint> = response.dataList
    return points.lastOrNull()
      ?.getValue(DataType.EnergyScoreType.ENERGY_SCORE)
  }

  /**
   * Cursor-based incremental read kept for completeness / future
   * multi-day backfill. Both data types implement
   * `DataType.ChangeReadable`, so `store.readChanges(...)` is
   * supported via the type's `changedDataRequestBuilder`. For the
   * single-daily-value sync this companion does, the windowed
   * [buildTodayPayload] read is preferred (a change cursor adds
   * token-expiry handling for no functional gain on one value/day).
   *
   * @return the new page token to persist for the next delta read,
   *   or null if nothing changed / not supported.
   */
  suspend fun readChangedSince(pageToken: String?): String? {
    val builder = DataTypes.ENERGY_SCORE.changedDataRequestBuilder
    if (pageToken != null) builder.setPageToken(pageToken)
    val request = builder.build()
    val response = store.readChanges(request)
    val changes = response.dataList
    Log.d(TAG, "readChanges: ${changes.size} change(s)")
    return response.pageToken
  }

  companion object {
    private const val TAG = "SamsungHealthReader"
  }
}
