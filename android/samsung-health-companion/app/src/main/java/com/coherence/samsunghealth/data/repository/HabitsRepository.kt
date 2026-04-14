package com.coherence.samsunghealth.data.repository

import android.util.Log
import com.coherence.samsunghealth.data.model.HabitStreak
import com.coherence.samsunghealth.data.model.HabitWithCompletion
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put

class HabitsRepository(private val trpc: TrpcClient, private val json: Json) {

  companion object {
    private const val TAG = "HabitsRepository"
  }

  suspend fun getForDate(dateKey: String? = null): List<HabitWithCompletion> {
    val input = dateKey?.let { buildJsonObject { put("dateKey", it) } }
    val result = trpc.query("habits.getForDate", input)
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(HabitWithCompletion.serializer(), it) }
    } catch (e: Exception) {
      Log.w(TAG, "getForDate failed", e)
      emptyList()
    }
  }

  suspend fun setCompletion(habitId: String, completed: Boolean, dateKey: String? = null): Boolean {
    return try {
      val input = buildJsonObject {
        put("habitId", habitId)
        put("completed", completed)
        dateKey?.let { put("dateKey", it) }
      }
      trpc.mutate("habits.setCompletion", input)
      true
    } catch (e: Exception) {
      Log.w(TAG, "setCompletion failed", e)
      false
    }
  }

  suspend fun getStreaks(): List<HabitStreak> {
    val result = trpc.query("habits.getStreaks")
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(HabitStreak.serializer(), it) }
    } catch (e: Exception) {
      Log.w(TAG, "getStreaks failed", e)
      emptyList()
    }
  }
}
