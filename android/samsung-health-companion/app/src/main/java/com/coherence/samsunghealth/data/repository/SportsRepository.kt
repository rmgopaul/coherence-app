package com.coherence.samsunghealth.data.repository

import com.coherence.samsunghealth.data.model.SportsResponse
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json

class SportsRepository(private val trpc: TrpcClient, private val json: Json) {

  suspend fun getGames(): SportsResponse {
    val result = trpc.query("sports.getGames")
    return json.decodeFromJsonElement(SportsResponse.serializer(), result)
  }
}
