package com.coherence.healthconnect.sdk

import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.response.ReadRecordsResponse
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/**
 * JVM unit tests for [HealthConnectReader].
 *
 * The reader was the class behind the 2026-04-19 unreachable-code
 * postmortem entry — its retry/backoff/cooldown loop is exactly the
 * kind of control flow that manual on-device testing misses but unit
 * tests catch in seconds. These tests pin every branch the reader's
 * single `read()` method has:
 *
 *  - Permission-denied short-circuit (warn vs. silent)
 *  - Happy path (records returned, succeeded log populated, cooldown
 *    cleared on success)
 *  - Retryable rate-limit error that succeeds on a later attempt
 *  - Rate-limit error that exhausts retries (cooldown is marked —
 *    the bug the postmortem documented)
 *  - Non-retryable error (reported as warning, cooldown NOT marked)
 *  - Foreground-requirement error on a type that suppresses it
 *    (silent skip, no warning)
 *  - WHOOP `dataOrigin.packageName` filter drops records client-side
 *  - Pagination: multi-page response concatenates correctly
 *
 * Uses `kotlinx-coroutines-test` so the reader's `delay(...)` calls
 * for backoff + post-success spacing don't actually block — virtual
 * time advances instantly.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HealthConnectReaderTest {

  private val tz: ZoneOffset = ZoneOffset.UTC
  private val now: Instant = Instant.parse("2026-04-19T12:00:00Z")
  private val range: TimeRangeFilter =
    TimeRangeFilter.between(now.minusSeconds(3600), now.plusSeconds(3600))

  private val stepsPermission = HealthPermission.getReadPermission(StepsRecord::class)

  // ──────────────────────────────────────────────────────────────────
  // Fakes
  // ──────────────────────────────────────────────────────────────────

  /**
   * Scripted [HealthConnectRecordSource] for a single record type.
   * Each `enqueue*` call appends to a queue that `readRecords` pops
   * in FIFO order. Tests script exactly the sequence of
   * success/throw responses they want to verify.
   *
   * If `readRecords` is called more times than the queue has, the
   * fake throws `IllegalStateException("queue exhausted")`. This is
   * intentional — production failures where the reader spins more
   * times than expected should fail loudly in tests.
   */
  private class ScriptedSource : HealthConnectRecordSource {
    private sealed class Response {
      data class Records(val records: List<Record>, val nextPageToken: String? = null) : Response()
      data class Throw(val error: Throwable) : Response()
    }

    private val queue: ArrayDeque<Response> = ArrayDeque()
    var callCount: Int = 0
      private set
    /** Every request passed into readRecords, in order. Useful for
     *  verifying pagination calls pass the right pageToken. */
    val requests: MutableList<ReadRecordsRequest<*>> = mutableListOf()

    fun enqueueSuccess(records: List<Record>, nextPageToken: String? = null) {
      queue += Response.Records(records, nextPageToken)
    }

    fun enqueueThrow(error: Throwable) {
      queue += Response.Throw(error)
    }

    @Suppress("UNCHECKED_CAST", "RestrictedApi")
    override suspend fun <T : Record> readRecords(
      request: ReadRecordsRequest<T>,
    ): ReadRecordsResponse<T> {
      callCount += 1
      requests += request
      val next = queue.removeFirstOrNull()
        ?: error("ScriptedSource queue exhausted after $callCount call(s)")
      return when (next) {
        is Response.Records ->
          ReadRecordsResponse(next.records as List<T>, next.nextPageToken)
        is Response.Throw -> throw next.error
      }
    }
  }

  /**
   * In-memory [RateLimitCooldownSink] spy. The real
   * [HealthConnectCooldown] persists to SharedPreferences, which
   * requires an Android Context we don't have on the JVM.
   */
  private class FakeCooldown : RateLimitCooldownSink {
    var markRateLimitedCalls: Int = 0
      private set
    var lastMarkedMessage: String? = null
      private set
    var clearCalls: Int = 0
      private set

    override fun markRateLimited(message: String) {
      markRateLimitedCalls += 1
      lastMarkedMessage = message
    }

    override fun clear() {
      clearCalls += 1
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Record fixtures
  // ──────────────────────────────────────────────────────────────────

  private fun stepsRecord(
    count: Long = 100,
    dataOriginPackage: String? = null,
  ): StepsRecord {
    // Always create a FRESH Metadata — `Metadata.manualEntry()` may
    // return a shared singleton. Reflecting over a shared instance
    // would contaminate every previously-built record with the same
    // DataOrigin, which was a real bug in an earlier draft of this
    // test (all records ended up with packageName="com.whoop.android"
    // so the filter dropped everything).
    val metadata = if (dataOriginPackage != null) {
      freshMetadataWithOrigin(dataOriginPackage)
    } else {
      Metadata.manualEntry()
    }
    return StepsRecord(
      startTime = now,
      startZoneOffset = tz,
      endTime = now.plusSeconds(60),
      endZoneOffset = tz,
      count = count,
      metadata = metadata,
    )
  }

  /**
   * Build a fresh [Metadata] whose `dataOrigin` has the given
   * [packageName]. The public `Metadata` API doesn't expose a way
   * to set this (platform sets it server-side at insert time), so
   * we reflect over Kotlin's internal constructor.
   *
   * Using the constructor directly (rather than mutating a
   * `manualEntry()` instance) guarantees each returned `Metadata`
   * is a distinct object.
   */
  private fun freshMetadataWithOrigin(packageName: String): Metadata {
    // Find the primary internal constructor.
    val ctor = Metadata::class.java.declaredConstructors
      .maxByOrNull { it.parameterCount }
      ?: error("Metadata has no declared constructors")
    ctor.isAccessible = true
    val paramTypes = ctor.parameterTypes
    // Construct with all defaults EXCEPT dataOrigin. The exact
    // parameter order in HC 1.1.0:
    //   int recordingMethod
    //   String id
    //   DataOrigin dataOrigin
    //   Instant lastModifiedTime
    //   String? clientRecordId
    //   long clientRecordVersion
    //   Device? device
    val args = arrayOfNulls<Any?>(paramTypes.size)
    for ((i, type) in paramTypes.withIndex()) {
      args[i] = when {
        type == Int::class.javaPrimitiveType -> 0
        type == Long::class.javaPrimitiveType -> 0L
        type == String::class.java -> ""
        type == DataOrigin::class.java -> DataOrigin(packageName)
        type == java.time.Instant::class.java -> java.time.Instant.EPOCH
        else -> null
      }
    }
    return ctor.newInstance(*args) as Metadata
  }

  // ──────────────────────────────────────────────────────────────────
  // Reader factories
  // ──────────────────────────────────────────────────────────────────

  private fun makeReader(
    source: HealthConnectRecordSource = ScriptedSource(),
    grantedPermissions: Set<String> = setOf(stepsPermission),
    cooldown: RateLimitCooldownSink? = FakeCooldown(),
    excludedPackageNames: Set<String> = emptySet(),
  ): HealthConnectReader =
    HealthConnectReader(
      source = source,
      grantedPermissions = grantedPermissions,
      cooldown = cooldown,
      excludedPackageNames = excludedPackageNames,
    )

  // ──────────────────────────────────────────────────────────────────
  // Tests
  // ──────────────────────────────────────────────────────────────────

  @Test
  fun `skips read and warns when permission is missing`() = runTest {
    val source = ScriptedSource()
    val cooldown = FakeCooldown()
    val reader = makeReader(
      source = source,
      grantedPermissions = emptySet(),
      cooldown = cooldown,
    )

    val result = reader.read(StepsRecord::class, range, "steps")

    assertTrue(result.isEmpty())
    assertEquals(0, source.callCount)
    assertTrue(reader.attempted.isEmpty())
    assertTrue(reader.succeeded.isEmpty())
    assertEquals(1, reader.warnings.size)
    assertTrue(reader.warnings[0].contains("permission not granted"))
    assertEquals(0, cooldown.markRateLimitedCalls)
    assertEquals(0, cooldown.clearCalls)
  }

  @Test
  fun `skips read silently when warnIfMissing is false`() = runTest {
    val reader = makeReader(grantedPermissions = emptySet())

    val result = reader.read(StepsRecord::class, range, "steps", warnIfMissing = false)

    assertTrue(result.isEmpty())
    assertTrue(reader.warnings.isEmpty())
  }

  @Test
  fun `happy path returns records, logs succeeded, clears cooldown`() = runTest {
    val source = ScriptedSource().apply {
      enqueueSuccess(listOf(stepsRecord(100), stepsRecord(200)))
    }
    val cooldown = FakeCooldown()
    val reader = makeReader(source = source, cooldown = cooldown)

    val result = reader.read(StepsRecord::class, range, "steps")

    assertEquals(2, result.size)
    assertEquals(100L, result[0].count)
    assertEquals(200L, result[1].count)
    assertEquals(listOf("steps"), reader.attempted)
    assertEquals(listOf("steps"), reader.succeeded)
    assertTrue(reader.warnings.isEmpty())
    assertEquals(1, cooldown.clearCalls)
    assertEquals(0, cooldown.markRateLimitedCalls)
  }

  @Test
  fun `retryable rate-limit error recovers on a later attempt`() = runTest {
    val source = ScriptedSource().apply {
      enqueueThrow(RuntimeException("Rate limited: quota exceeded"))
      enqueueSuccess(listOf(stepsRecord(500)))
    }
    val cooldown = FakeCooldown()
    val reader = makeReader(source = source, cooldown = cooldown)

    val result = reader.read(StepsRecord::class, range, "steps")

    assertEquals(1, result.size)
    assertEquals(500L, result[0].count)
    assertEquals(2, source.callCount)
    assertEquals(listOf("steps"), reader.succeeded)
    // The earlier rate-limit error should NOT have marked the
    // cooldown — only exhausted retries do that.
    assertEquals(0, cooldown.markRateLimitedCalls)
    // The successful read DOES clear the cooldown.
    assertEquals(1, cooldown.clearCalls)
    assertTrue(reader.warnings.isEmpty())
  }

  @Test
  fun `exhausted rate-limit retries mark the cooldown`() = runTest {
    // Regression guard: this exact scenario shipped as the
    // "cooldown unreachable-code" bug. Pre-fix, the cooldown
    // would never be marked. This test fails on the pre-fix code
    // because cooldown.markRateLimitedCalls stays 0.
    val source = ScriptedSource().apply {
      enqueueThrow(RuntimeException("Rate limit exceeded"))
      enqueueThrow(RuntimeException("Rate limit exceeded"))
      enqueueThrow(RuntimeException("Rate limit exceeded"))
    }
    val cooldown = FakeCooldown()
    val reader = makeReader(source = source, cooldown = cooldown)

    val result = reader.read(StepsRecord::class, range, "steps")

    assertTrue(result.isEmpty())
    assertEquals(3, source.callCount)
    assertTrue(reader.succeeded.isEmpty())
    assertEquals(1, cooldown.markRateLimitedCalls)
    assertNotNull(cooldown.lastMarkedMessage)
    assertTrue(cooldown.lastMarkedMessage!!.lowercase().contains("rate limit"))
    // Warning text should indicate retries were exhausted.
    assertEquals(1, reader.warnings.size)
    assertTrue(
      reader.warnings[0].contains("after 3 attempts", ignoreCase = true) ||
        reader.warnings[0].contains("rate limited", ignoreCase = true),
    )
    // Cooldown is NOT cleared on failure.
    assertEquals(0, cooldown.clearCalls)
  }

  @Test
  fun `non-retryable error surfaces a warning and does NOT mark cooldown`() = runTest {
    val source = ScriptedSource().apply {
      enqueueThrow(IllegalStateException("Some other internal error"))
    }
    val cooldown = FakeCooldown()
    val reader = makeReader(source = source, cooldown = cooldown)

    val result = reader.read(StepsRecord::class, range, "steps")

    assertTrue(result.isEmpty())
    // Only one attempt — non-rate-limit errors don't retry.
    assertEquals(1, source.callCount)
    assertTrue(reader.succeeded.isEmpty())
    assertEquals(1, reader.warnings.size)
    assertTrue(reader.warnings[0].contains("Some other internal error"))
    // Critically: cooldown is NOT marked for non-rate-limit failures.
    assertEquals(0, cooldown.markRateLimitedCalls)
    assertEquals(0, cooldown.clearCalls)
  }

  @Test
  fun `foreground-requirement error is silently swallowed when suppressed`() = runTest {
    val source = ScriptedSource().apply {
      enqueueThrow(SecurityException("Reads must be in foreground"))
    }
    val cooldown = FakeCooldown()
    val reader = makeReader(source = source, cooldown = cooldown)

    val result = reader.read(
      StepsRecord::class,
      range,
      "steps",
      suppressForegroundRequirementWarning = true,
    )

    assertTrue(result.isEmpty())
    assertEquals(1, source.callCount)
    // No warning recorded — this error is expected on background
    // workers and not user-actionable.
    assertTrue(reader.warnings.isEmpty())
    assertTrue(reader.succeeded.isEmpty())
    assertEquals(0, cooldown.markRateLimitedCalls)
  }

  @Test
  fun `WHOOP records are filtered out by default`() = runTest {
    val whoopRecord = stepsRecord(count = 999, dataOriginPackage = "com.whoop.android")
    val samsungRecord = stepsRecord(count = 10000, dataOriginPackage = "com.sec.android.app.shealth")
    val source = ScriptedSource().apply {
      enqueueSuccess(listOf(whoopRecord, samsungRecord))
    }
    val reader = makeReader(
      source = source,
      excludedPackageNames = HealthConnectReader.DEFAULT_EXCLUDED_PACKAGES,
    )

    val result = reader.read(StepsRecord::class, range, "steps")

    assertEquals(1, result.size)
    assertEquals(10000L, result[0].count)
    assertEquals("com.sec.android.app.shealth", result[0].metadata.dataOrigin.packageName)
  }

  @Test
  fun `empty excluded-packages set passes all records through`() = runTest {
    val whoopRecord = stepsRecord(count = 999, dataOriginPackage = "com.whoop.android")
    val source = ScriptedSource().apply { enqueueSuccess(listOf(whoopRecord)) }
    val reader = makeReader(source = source, excludedPackageNames = emptySet())

    val result = reader.read(StepsRecord::class, range, "steps")

    assertEquals(1, result.size)
    assertEquals("com.whoop.android", result[0].metadata.dataOrigin.packageName)
  }

  @Test
  fun `pagination concatenates pages and stops when pageToken is null`() = runTest {
    val source = ScriptedSource().apply {
      enqueueSuccess(listOf(stepsRecord(1), stepsRecord(2)), nextPageToken = "page2")
      enqueueSuccess(listOf(stepsRecord(3), stepsRecord(4)), nextPageToken = "page3")
      enqueueSuccess(listOf(stepsRecord(5)), nextPageToken = null)
    }
    val reader = makeReader(source = source)

    val result = reader.read(StepsRecord::class, range, "steps")

    assertEquals(5, result.size)
    assertEquals(listOf(1L, 2L, 3L, 4L, 5L), result.map { it.count })
    assertEquals(3, source.callCount)
    // Verify pageToken threaded through correctly.
    assertNull(source.requests[0].pageToken)
    assertEquals("page2", source.requests[1].pageToken)
    assertEquals("page3", source.requests[2].pageToken)
  }

  @Test
  fun `cooldown parameter is optional — reader works without one`() = runTest {
    // Production SDK status may construct the reader without a
    // cooldown (not hit that path currently, but the constructor
    // allows it). Ensure nothing NPEs.
    val source = ScriptedSource().apply {
      enqueueThrow(RuntimeException("Rate limit exceeded"))
      enqueueThrow(RuntimeException("Rate limit exceeded"))
      enqueueThrow(RuntimeException("Rate limit exceeded"))
    }
    val reader = makeReader(source = source, cooldown = null)

    val result = reader.read(StepsRecord::class, range, "steps")

    assertTrue(result.isEmpty())
    assertEquals(3, source.callCount)
    assertEquals(1, reader.warnings.size)
  }
}
