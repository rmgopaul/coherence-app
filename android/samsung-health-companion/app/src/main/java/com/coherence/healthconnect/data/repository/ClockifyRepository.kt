package com.coherence.healthconnect.data.repository

import android.util.Log
import com.coherence.healthconnect.data.model.ClockifyStatus
import com.coherence.healthconnect.data.model.ClockifyStopResult
import com.coherence.healthconnect.data.model.ClockifyTimeEntry
import com.coherence.healthconnect.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put

class ClockifyRepository(private val trpc: TrpcClient, private val json: Json) {

  companion object {
    private const val TAG = "ClockifyRepository"
  }

  suspend fun getStatus(): ClockifyStatus? {
    return try {
      val result = trpc.query("clockify.getStatus")
      json.decodeFromJsonElement(ClockifyStatus.serializer(), result)
    } catch (e: Exception) {
      Log.w(TAG, "getStatus failed", e)
      null
    }
  }

  suspend fun getCurrentEntry(): ClockifyTimeEntry? {
    return try {
      val result = trpc.query("clockify.getCurrentEntry")
      json.decodeFromJsonElement(ClockifyTimeEntry.serializer(), result)
    } catch (e: Exception) {
      Log.w(TAG, "getCurrentEntry failed", e)
      null
    }
  }

  suspend fun getRecentEntries(limit: Int = 20): List<ClockifyTimeEntry> {
    return try {
      val input = buildJsonObject { put("limit", limit) }
      val result = trpc.query("clockify.getRecentEntries", input)
      result.jsonArray.map { json.decodeFromJsonElement(ClockifyTimeEntry.serializer(), it) }
    } catch (e: Exception) {
      Log.w(TAG, "getRecentEntries failed", e)
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
    } catch (e: Exception) {
      Log.w(TAG, "startTimer failed", e)
      null
    }
  }

  suspend fun stopTimer(): Boolean {
    return try {
      val result = trpc.mutate("clockify.stopTimer")
      val stop = json.decodeFromJsonElement(ClockifyStopResult.serializer(), result)
      stop.success
    } catch (e: Exception) {
      Log.w(TAG, "stopTimer failed", e)
      false
    }
  }
}
