package com.coherence.healthconnect.sdk

import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import android.util.Log
import kotlinx.coroutines.delay
import kotlin.reflect.KClass

/**
 * Typed, paginated record reader. Knows how to:
 *  - Check whether a permission has been granted before attempting a read.
 *  - Follow pagination tokens until the full window is exhausted.
 *  - Space successive reads with a small post-read delay so a tight
 *    burst of calls (e.g. a historical backfill) does not trip
 *    Health Connect's per-app rate limiter.
 *  - Detect rate-limit / quota errors and retry with exponential
 *    backoff instead of surfacing them as permanent warnings.
 *  - Promote a persistent rate-limit hit into a global cooldown via
 *    [HealthConnectCooldown] so subsequent sync runs back off
 *    entirely instead of digging the quota hole deeper.
 *  - Surface per-record-type warnings into shared log buffers so the
 *    final payload reports exactly what was attempted and what failed.
 *
 * Record selection and mapping live in [HealthConnectPayloadMapper];
 * this class is deliberately data-type agnostic.
 */
class HealthConnectReader internal constructor(
  private val source: HealthConnectRecordSource,
  private val grantedPermissions: Set<String>,
  private val cooldown: RateLimitCooldownSink? = null,
  /**
   * Records whose `metadata.dataOrigin.packageName` is in this set
   * are dropped client-side after the read returns, never reaching
   * the mapper.
   *
   * Use case: WHOOP stays a *separate* dashboard integration that
   * goes through our server's WHOOP OAuth pipeline, NOT through
   * Health Connect. If WHOOP's Android app ever starts writing to
   * Health Connect, this filter keeps our HC sync from
   * double-counting metrics that already arrive via the WHOOP
   * server-side path.
   *
   * Also useful for deduping: when two apps (e.g. Samsung Health +
   * Renpho scale) both write the same metric, filtering lets us
   * pick a primary source per metric category.
   */
  private val excludedPackageNames: Set<String> = DEFAULT_EXCLUDED_PACKAGES,
) {

  /**
   * Production constructor. Adapts a real
   * [androidx.health.connect.client.HealthConnectClient] into the
   * narrower [HealthConnectRecordSource] the reader actually uses,
   * and takes the concrete [HealthConnectCooldown] class rather
   * than the internal [RateLimitCooldownSink] interface so this
   * overload can stay public.
   */
  constructor(
    client: androidx.health.connect.client.HealthConnectClient,
    grantedPermissions: Set<String>,
    cooldown: HealthConnectCooldown? = null,
    excludedPackageNames: Set<String> = DEFAULT_EXCLUDED_PACKAGES,
  ) : this(
    source = HealthConnectRecordSource.from(client),
    grantedPermissions = grantedPermissions,
    cooldown = cooldown as RateLimitCooldownSink?,
    excludedPackageNames = excludedPackageNames,
  )

  /** Mutable log of record-type labels that were read attempted. */
  val attempted: MutableList<String> = mutableListOf()

  /** Labels that returned at least zero records without throwing. */
  val succeeded: MutableList<String> = mutableListOf()

  /** Free-text warnings to surface in the sync payload. */
  val warnings: MutableList<String> = mutableListOf()

  /**
   * Set to `true` once any [read] call in this reader instance has
   * hit a rate-limit error. All subsequent [read] calls short-circuit
   * without issuing HTTP to Health Connect.
   *
   * Why this matters: a single sync iterates ~22 typed reads. Without
   * this flag, the first rate-limit hit engages cooldown but the
   * remaining 21 types each issue fresh HC calls that all hit the
   * limiter. Every failed call still debits the rolling 24h quota
   * window, which is exactly the mechanism that kept the app's
   * cooldown stuck for hours in 0.5.x: each "retry burst" extended
   * the quota exhaustion slightly, preventing recovery.
   */
  private var quotaExhaustedThisSync: Boolean = false

  /**
   * Read all records of [recordType] within [range]. If the permission
   * has not been granted, skip the read and record a warning (unless
   * [warnIfMissing] is false).
   *
   * Rate-limit errors are NOT retried. Health Connect's quota is a
   * rolling 24h window — retrying 3× with 1–4 s backoff can't beat
   * a 24h window, but it DOES burn 3 more of the exhausted budget
   * per type. The first rate-limit hit engages the global cooldown
   * and sets [quotaExhaustedThisSync] so the remaining types in the
   * same sync short-circuit without calling HC.
   *
   * [suppressForegroundRequirementWarning] exists because some record
   * types (notably [androidx.health.connect.client.records.BodyFatRecord])
   * raise a "must be in foreground" error when the app is a background
   * worker — that is expected and not actionable.
   */
  suspend fun <T : Record> read(
    recordType: KClass<T>,
    range: TimeRangeFilter,
    label: String,
    warnIfMissing: Boolean = true,
    suppressForegroundRequirementWarning: Boolean = false,
  ): List<T> {
    val permission = HealthPermission.getReadPermission(recordType)
    if (!grantedPermissions.contains(permission)) {
      if (warnIfMissing) {
        warnings += "$label skipped: permission not granted"
      }
      return emptyList()
    }

    if (quotaExhaustedThisSync) {
      warnings += "$label skipped: rate-limit cooldown engaged earlier this sync"
      return emptyList()
    }

    attempted += label

    try {
      val all = mutableListOf<T>()
      var pageToken: String? = null
      do {
        val response = source.readRecords(
          ReadRecordsRequest(
            recordType = recordType,
            timeRangeFilter = range,
            pageToken = pageToken,
          ),
        )
        all += response.records
        pageToken = response.pageToken
      } while (pageToken != null)

      succeeded += label
      // Any successful read is conclusive evidence the quota has
      // recovered enough to make progress, so clear any prior
      // cooldown marker.
      cooldown?.clear()
      // Strip records from excluded data sources (e.g. WHOOP) so
      // they never reach the mapper. Done after the HC call so the
      // quota debit is identical — there's no way to pre-filter at
      // the HC API level.
      val filtered = if (excludedPackageNames.isEmpty()) {
        all
      } else {
        val kept = all.filterNot { record ->
          record.metadata.dataOrigin.packageName in excludedPackageNames
        }
        val dropped = all.size - kept.size
        if (dropped > 0) {
          Log.d(TAG, "$label dropped $dropped records from excluded sources")
        }
        kept
      }
      // Post-success spacing: when many read() calls run back-to-back
      // (e.g. a 22-type range fetch during a historical backfill),
      // Health Connect's per-app rate limiter treats bursts more
      // harshly than spread-out calls. 50 ms * 22 types ≈ 1.1 s of
      // extra latency per sync, which is invisible to the user but
      // keeps us comfortably inside the quota.
      delay(POST_READ_SPACING_MS)
      return filtered
    } catch (error: Throwable) {
      val combined = buildErrorMessage(error)

      if (
        suppressForegroundRequirementWarning &&
        combined.contains("must be in foreground", ignoreCase = true)
      ) {
        return emptyList()
      }

      if (isRateLimitError(combined)) {
        quotaExhaustedThisSync = true
        cooldown?.markRateLimited(combined)
        Log.w(
          TAG,
          "$label rate-limited; cooldown engaged, remaining record types will be skipped",
        )
        warnings += "$label read failed (rate limited): ${error.message ?: "unknown"}"
      } else {
        warnings += "$label read failed: ${error.message ?: error.javaClass.simpleName}"
      }
      return emptyList()
    }
  }

  private fun buildErrorMessage(error: Throwable): String {
    val primary = error.message ?: error.javaClass.simpleName
    val cause = error.cause?.message
    return if (!cause.isNullOrBlank() && cause != primary) {
      "$primary ($cause)"
    } else {
      primary
    }
  }

  private fun isRateLimitError(message: String): Boolean {
    val lower = message.lowercase()
    return lower.contains("rate limit") ||
      lower.contains("rate-limited") ||
      lower.contains("rate limited") ||
      lower.contains("quota has been exceeded") ||
      lower.contains("quota exceeded") ||
      lower.contains("too many requests") ||
      lower.contains("throttled")
  }

  companion object {
    private const val TAG = "HealthConnectReader"
    private const val POST_READ_SPACING_MS = 50L

    /**
     * Package names whose records are filtered out of every HC read
     * by default. WHOOP is excluded because the dashboard surfaces
     * WHOOP metrics via a separate server-side OAuth integration —
     * mixing the two sources would double-count calories, exercise,
     * and sleep.
     */
    val DEFAULT_EXCLUDED_PACKAGES: Set<String> = setOf(
      "com.whoop.android",
    )
  }
}
