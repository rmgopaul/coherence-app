package com.coherence.samsunghealth.data.repository

import com.coherence.samsunghealth.data.model.SupplementDefinition
import com.coherence.samsunghealth.data.model.SupplementLog
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put

class SupplementsRepository(private val trpc: TrpcClient) {

  private val json = Json { ignoreUnknownKeys = true }

  suspend fun listDefinitions(): List<SupplementDefinition> {
    val result = trpc.query("supplements.listDefinitions")
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(SupplementDefinition.serializer(), it) }
    } catch (_: Exception) { emptyList() }
  }

  suspend fun getLogs(dateKey: String? = null): List<SupplementLog> {
    val input = dateKey?.let { buildJsonObject { put("dateKey", it) } }
    val result = trpc.query("supplements.getLogs", input)
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(SupplementLog.serializer(), it) }
    } catch (_: Exception) { emptyList() }
  }

  suspend fun addLog(name: String, dose: String, doseUnit: String = "capsule", timing: String = "am", dateKey: String? = null, definitionId: String? = null): Boolean {
    return try {
      val input = buildJsonObject {
        put("name", name)
        put("dose", dose)
        put("doseUnit", doseUnit)
        put("timing", timing)
        dateKey?.let { put("dateKey", it) }
        definitionId?.let { put("definitionId", it) }
      }
      trpc.mutate("supplements.addLog", input)
      true
    } catch (_: Exception) { false }
  }

  suspend fun deleteLog(id: String): Boolean {
    return try {
      trpc.mutate("supplements.deleteLog", buildJsonObject { put("id", id) })
      true
    } catch (_: Exception) { false }
  }
}
