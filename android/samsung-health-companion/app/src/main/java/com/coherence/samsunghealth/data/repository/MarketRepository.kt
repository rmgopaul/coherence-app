package com.coherence.samsunghealth.data.repository

import com.coherence.samsunghealth.data.model.MarketDashboardResponse
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json

class MarketRepository(private val trpc: TrpcClient) {

  private val json = Json { ignoreUnknownKeys = true }

  suspend fun getMarketDashboard(): MarketDashboardResponse {
    val result = trpc.query("marketDashboard.getMarketData")
    return json.decodeFromJsonElement(MarketDashboardResponse.serializer(), result)
  }
}
