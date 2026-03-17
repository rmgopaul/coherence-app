package com.coherence.samsunghealth.data.repository

import com.coherence.samsunghealth.data.model.DailyHealthMetric
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put

class MetricsRepository(private val trpc: TrpcClient) {

  private val json = Json { ignoreUnknownKeys = true }

  suspend fun getHistory(limit: Int = 30): List<DailyHealthMetric> {
    val input = buildJsonObject { put("limit", limit) }
    val result = trpc.query("metrics.getHistory", input)
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(DailyHealthMetric.serializer(), it) }
    } catch (_: Exception) { emptyList() }
  }

  suspend fun captureToday(): Boolean {
    return try {
      trpc.mutate("metrics.captureToday")
      true
    } catch (_: Exception) { false }
  }
}
