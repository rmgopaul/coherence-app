package com.coherence.samsunghealth.data.repository

import com.coherence.samsunghealth.data.model.WhoopSummary
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json

class WhoopRepository(private val trpc: TrpcClient, private val json: Json) {

  suspend fun getSummary(): WhoopSummary? {
    val result = trpc.query("whoop.getSummary")
    return json.decodeFromJsonElement(WhoopSummary.serializer(), result)
  }
}
