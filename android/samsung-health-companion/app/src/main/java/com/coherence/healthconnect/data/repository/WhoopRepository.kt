package com.coherence.healthconnect.data.repository

import com.coherence.healthconnect.data.model.WhoopSummary
import com.coherence.healthconnect.network.TrpcClient
import kotlinx.serialization.json.Json

class WhoopRepository(private val trpc: TrpcClient, private val json: Json) {

  suspend fun getSummary(): WhoopSummary? {
    val result = trpc.query("whoop.getSummary")
    return json.decodeFromJsonElement(WhoopSummary.serializer(), result)
  }
}
