package com.coherence.samsunghealth.network

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * Decodes superjson-encoded responses from the tRPC server.
 * superjson wraps data in {"json": ..., "meta": {"values": {...}}} where meta.values
 * contains type annotations (e.g., "Date" for ISO date strings).
 * For our purposes, we extract the "json" field and leave date strings as-is
 * (Kotlin handles ISO strings via kotlinx.datetime or manual parsing).
 */
object SuperJsonDecoder {

  fun decode(element: JsonElement): JsonElement {
    if (element !is JsonObject) return element
    val obj = element.jsonObject
    val json = obj["json"] ?: return element
    return json
  }

  fun decodeTrpcResult(responseBody: JsonElement): JsonElement {
    if (responseBody !is JsonObject) return responseBody

    // Single query: {"result": {"data": {"json": ..., "meta": ...}}}
    val result = responseBody.jsonObject["result"]
    if (result is JsonObject) {
      val data = result.jsonObject["data"]
      if (data is JsonObject) {
        return decode(data)
      }
      return data ?: result
    }

    // Batched queries: [{"result": {"data": ...}}, ...]
    if (responseBody.jsonObject.isEmpty()) return responseBody
    return responseBody
  }

}
