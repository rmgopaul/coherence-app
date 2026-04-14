package com.coherence.samsunghealth.data.repository

import com.coherence.samsunghealth.data.model.GlobalSearchResponse
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class SearchRepository(private val trpc: TrpcClient, private val json: Json) {

  suspend fun globalSearch(query: String, limit: Int = 30): GlobalSearchResponse {
    val input = buildJsonObject {
      put("query", query)
      put("limit", limit)
    }
    val result = trpc.query("search.global", input)
    return json.decodeFromJsonElement(GlobalSearchResponse.serializer(), result)
  }
}
