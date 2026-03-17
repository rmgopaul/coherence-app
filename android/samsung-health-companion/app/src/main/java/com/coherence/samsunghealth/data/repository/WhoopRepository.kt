package com.coherence.samsunghealth.data.repository

import com.coherence.samsunghealth.data.model.WhoopSummary
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json

class WhoopRepository(private val trpc: TrpcClient) {

  private val json = Json { ignoreUnknownKeys = true }

  suspend fun getSummary(): WhoopSummary? {
    return try {
      val result = trpc.query("whoop.getSummary")
      json.decodeFromJsonElement(WhoopSummary.serializer(), result)
    } catch (_: Exception) {
      null
    }
  }
}
