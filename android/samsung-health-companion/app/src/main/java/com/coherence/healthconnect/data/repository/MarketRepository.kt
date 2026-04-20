package com.coherence.healthconnect.data.repository

import com.coherence.healthconnect.data.model.MarketDashboardResponse
import com.coherence.healthconnect.network.TrpcClient
import kotlinx.serialization.json.Json

class MarketRepository(private val trpc: TrpcClient, private val json: Json) {

  suspend fun getMarketDashboard(): MarketDashboardResponse {
    val result = trpc.query("marketDashboard.getMarketData")
    return json.decodeFromJsonElement(MarketDashboardResponse.serializer(), result)
  }
}
