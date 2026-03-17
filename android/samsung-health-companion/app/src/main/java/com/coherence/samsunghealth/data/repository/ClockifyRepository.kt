package com.coherence.samsunghealth.data.repository

import com.coherence.samsunghealth.data.model.ClockifyStatus
import com.coherence.samsunghealth.data.model.ClockifyStopResult
import com.coherence.samsunghealth.data.model.ClockifyTimeEntry
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put

class ClockifyRepository(private val trpc: TrpcClient) {

  private val json = Json { ignoreUnknownKeys = true }

  suspend fun getStatus(): ClockifyStatus? {
    return try {
      val result = trpc.query("clockify.getStatus")
      json.decodeFromJsonElement(ClockifyStatus.serializer(), result)
    } catch (_: Exception) {
      null
    }
  }

  suspend fun getCurrentEntry(): ClockifyTimeEntry? {
    return try {
      val result = trpc.query("clockify.getCurrentEntry")
      json.decodeFromJsonElement(ClockifyTimeEntry.serializer(), result)
    } catch (_: Exception) {
      null
    }
  }

  suspend fun getRecentEntries(limit: Int = 20): List<ClockifyTimeEntry> {
    return try {
      val input = buildJsonObject { put("limit", limit) }
      val result = trpc.query("clockify.getRecentEntries", input)
      result.jsonArray.map { json.decodeFromJsonElement(ClockifyTimeEntry.serializer(), it) }
    } catch (_: Exception) {
      emptyList()
    }
  }

  suspend fun startTimer(description: String, projectId: String? = null): ClockifyTimeEntry? {
    return try {
      val input = buildJsonObject {
        put("description", description)
        if (projectId != null) put("projectId", projectId)
      }
      val result = trpc.mutate("clockify.startTimer", input)
      json.decodeFromJsonElement(ClockifyTimeEntry.serializer(), result)
    } catch (_: Exception) {
      null
    }
  }

  suspend fun stopTimer(): Boolean {
    return try {
      val result = trpc.mutate("clockify.stopTimer")
      val stop = json.decodeFromJsonElement(ClockifyStopResult.serializer(), result)
      stop.success
    } catch (_: Exception) {
      false
    }
  }
}
