package com.coherence.samsunghealth.sdk

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlin.reflect.KClass

/**
 * Typed, paginated record reader. Knows how to:
 *  - Check whether a permission has been granted before attempting a read.
 *  - Follow pagination tokens until the full window is exhausted.
 *  - Surface per-record-type warnings into shared log buffers so the
 *    final payload reports exactly what was attempted and what failed.
 *
 * Record selection and mapping live in [HealthConnectPayloadMapper];
 * this class is deliberately data-type agnostic.
 */
class HealthConnectReader(
  private val client: HealthConnectClient,
  private val grantedPermissions: Set<String>,
) {

  /** Mutable log of record-type labels that were read attempted. */
  val attempted: MutableList<String> = mutableListOf()

  /** Labels that returned at least zero records without throwing. */
  val succeeded: MutableList<String> = mutableListOf()

  /** Free-text warnings to surface in the sync payload. */
  val warnings: MutableList<String> = mutableListOf()

  /**
   * Read all records of [recordType] within [range]. If the permission
   * has not been granted, skip the read and record a warning (unless
   * [warnIfMissing] is false).
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

    attempted += label
    val all = mutableListOf<T>()
    var pageToken: String? = null

    return try {
      do {
        val response = client.readRecords(
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
      all
    } catch (error: Throwable) {
      val message = (error.message ?: error.javaClass.simpleName)
      val combined = buildString {
        append(message)
        val cause = error.cause?.message
        if (!cause.isNullOrBlank() && cause != message) {
          append(" (")
          append(cause)
          append(')')
        }
      }
      if (
        suppressForegroundRequirementWarning &&
        combined.contains("must be in foreground", ignoreCase = true)
      ) {
        return emptyList()
      }
      warnings += "$label read failed: $message"
      emptyList()
    }
  }
}
