package com.coherence.healthconnect.data.repository

import android.util.Log
import com.coherence.healthconnect.data.model.DailyHealthMetric
import com.coherence.healthconnect.data.model.TrendSeriesResponse
import com.coherence.healthconnect.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put

class MetricsRepository(private val trpc: TrpcClient, private val json: Json) {

  companion object {
    private const val TAG = "MetricsRepository"
  }

  suspend fun getHistory(limit: Int = 30): List<DailyHealthMetric> {
    val input = buildJsonObject { put("limit", limit) }
    val result = trpc.query("metrics.getHistory", input)
    return result.jsonArray.map { json.decodeFromJsonElement(DailyHealthMetric.serializer(), it) }
  }

  suspend fun getTrendSeries(days: Int = 30): TrendSeriesResponse {
    val input = buildJsonObject { put("days", days) }
    val result = trpc.query("metrics.getTrendSeries", input)
    return json.decodeFromJsonElement(TrendSeriesResponse.serializer(), result)
  }

  suspend fun captureToday(): Boolean {
    return try {
      trpc.mutate("metrics.captureToday")
      true
    } catch (e: Exception) {
      Log.w(TAG, "captureToday failed", e)
      false
    }
  }
}
