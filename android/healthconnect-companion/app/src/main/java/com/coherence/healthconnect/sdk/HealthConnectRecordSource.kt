package com.coherence.healthconnect.sdk

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.response.ReadRecordsResponse

/**
 * Narrow interface over the single [HealthConnectClient] method the
 * [HealthConnectReader] actually uses. By depending on this instead
 * of the full 15-method client interface, the reader becomes
 * JVM-unit-testable without Robolectric, mockk, or a hand-rolled
 * fake that has to stub every `HealthConnectClient` method.
 *
 * This is a regular `interface` (not a `fun interface` / SAM) because
 * Kotlin forbids generic methods on functional interfaces — the
 * `<T : Record>` parameter forces a named interface.
 *
 * Production construction is a one-line adapter via [from]:
 *
 * ```kotlin
 * val source = HealthConnectRecordSource.from(HealthConnectClient.getOrCreate(context))
 * ```
 *
 * Test construction is whatever the test needs — usually a queue
 * of scripted responses keyed by record type label.
 */
internal interface HealthConnectRecordSource {
  suspend fun <T : Record> readRecords(request: ReadRecordsRequest<T>): ReadRecordsResponse<T>

  companion object {
    /** Adapt a real [HealthConnectClient] so it satisfies this interface. */
    fun from(client: HealthConnectClient): HealthConnectRecordSource =
      object : HealthConnectRecordSource {
        override suspend fun <T : Record> readRecords(
          request: ReadRecordsRequest<T>,
        ): ReadRecordsResponse<T> = client.readRecords(request)
      }
  }
}
