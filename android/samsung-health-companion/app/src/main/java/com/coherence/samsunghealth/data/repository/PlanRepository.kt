package com.coherence.samsunghealth.data.repository

import android.util.Log
import com.coherence.samsunghealth.data.model.DailyOverview
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class PlanRepository(private val trpc: TrpcClient, private val json: Json) {

  /**
   * Generate a daily overview using the server's OpenAI integration.
   */
  suspend fun generateDailyOverview(
    date: String,
    taskSummaries: List<String> = emptyList(),
    eventSummaries: List<String> = emptyList(),
    emailSummaries: List<String> = emptyList(),
  ): String? {
    return try {
      val input = buildJsonObject {
        put("date", date)
        put("todoistTasks", JsonArray(taskSummaries.take(20).map { task ->
          buildJsonObject { put("content", task) }
        }))
        put("calendarEvents", JsonArray(eventSummaries.take(20).map { event ->
          buildJsonObject { put("summary", event) }
        }))
        put("prioritizedEmails", JsonArray(emailSummaries.take(20).map { email ->
          buildJsonObject { put("subject", email) }
        }))
      }
      Log.d("PlanRepository", "Generating plan for $date with ${taskSummaries.size} tasks, ${eventSummaries.size} events")
      val result = trpc.mutate("openai.generateDailyOverview", input)
      Log.d("PlanRepository", "Plan result: ${result.toString().take(200)}")
      json.decodeFromJsonElement(DailyOverview.serializer(), result).overview
    } catch (e: Exception) {
      Log.e("PlanRepository", "Failed to generate plan", e)
      null
    }
  }
}
