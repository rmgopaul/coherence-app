package com.coherence.samsunghealth.data.repository

import com.coherence.samsunghealth.data.model.TodoistTask
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put

class TodoistRepository(private val trpc: TrpcClient) {

  private val json = Json { ignoreUnknownKeys = true }

  suspend fun getTasks(filter: String? = null): List<TodoistTask> {
    val input = filter?.let {
      buildJsonObject { put("filter", it) }
    }
    val result = trpc.query("todoist.getTasks", input)
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(TodoistTask.serializer(), it) }
    } catch (_: Exception) {
      emptyList()
    }
  }

  suspend fun completeTask(taskId: String): Boolean {
    return try {
      val input = buildJsonObject { put("taskId", taskId) }
      trpc.mutate("todoist.completeTask", input)
      true
    } catch (_: Exception) {
      false
    }
  }

  suspend fun createTask(content: String, dueString: String? = null): Boolean {
    return try {
      val input = buildJsonObject {
        put("content", content)
        dueString?.let { put("dueString", it) }
      }
      trpc.mutate("todoist.createTask", input)
      true
    } catch (_: Exception) {
      false
    }
  }
}
