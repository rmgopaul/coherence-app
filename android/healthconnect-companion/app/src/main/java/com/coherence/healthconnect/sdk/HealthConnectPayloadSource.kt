package com.coherence.healthconnect.sdk

import com.coherence.healthconnect.model.SamsungHealthPayload
import java.time.LocalDate

/**
 * Contract for collecting health data from the underlying provider
 * (Google Health Connect) and producing normalized [SamsungHealthPayload]
 * snapshots.
 *
 * Note: the name "Samsung Health" is historical. This layer reads from
 * Health Connect, which aggregates Samsung Health, Google Fit, Fitbit,
 * Garmin, and many other sources.
 */
interface HealthConnectPayloadSource {

  /**
   * Collect a snapshot for *today* using the device's current time zone.
   * Convenience wrapper around [collectPayloadForDate].
   */
  suspend fun collectDailyPayload(): SamsungHealthPayload

  /**
   * Collect a snapshot for the given local date. Used both for the
   * regular daily sync (today) and for historical backfills.
   *
   * The returned payload always includes a full day's window
   * (midnight → midnight local), regardless of when it is called.
   */
  suspend fun collectPayloadForDate(date: LocalDate): SamsungHealthPayload

  /**
   * Collect snapshots for a contiguous range of local dates (inclusive).
   * Dates are processed in chronological order. If a single date fails
   * to collect, the error is captured as a warning on that date's
   * payload and iteration continues.
   *
   * @return one payload per date in [startDate]..[endDate] inclusive.
   */
  suspend fun collectPayloadRange(
    startDate: LocalDate,
    endDate: LocalDate,
  ): List<SamsungHealthPayload>

  /**
   * Return the current connection and permission state without
   * actually reading any records. Cheap to call.
   */
  suspend fun getConnectionStatus(): HealthConnectStatus
}
