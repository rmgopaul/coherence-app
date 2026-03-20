package com.coherence.samsunghealth.data.repository

import com.coherence.samsunghealth.data.model.TodoistProject
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
    return result.jsonArray.map { json.decodeFromJsonElement(TodoistTask.serializer(), it) }
  }

  suspend fun getProjects(): List<TodoistProject> {
    val result = trpc.query("todoist.getProjects")
    return result.jsonArray.map { json.decodeFromJsonElement(TodoistProject.serializer(), it) }
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

  suspend fun createTask(
    content: String,
    description: String? = null,
    projectId: String? = null,
    priority: Int? = null,
    dueString: String? = null,
    dueDate: String? = null,
  ): TodoistTask? {
    return try {
      val input = buildJsonObject {
        put("content", content)
        description?.takeIf { it.isNotBlank() }?.let { put("description", it) }
        projectId?.takeIf { it.isNotBlank() }?.let { put("projectId", it) }
        priority?.let { put("priority", it) }
        dueString?.let { put("dueString", it) }
        dueDate?.let { put("dueDate", it) }
      }
      val result = trpc.mutate("todoist.createTask", input)
      json.decodeFromJsonElement(TodoistTask.serializer(), result)
    } catch (_: Exception) {
      null
    }
  }
}
