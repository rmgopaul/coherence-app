package com.coherence.samsunghealth.data.repository

import android.util.Log
import com.coherence.samsunghealth.data.model.Note
import com.coherence.samsunghealth.data.model.NoteCreateResult
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put

class NotesRepository(private val trpc: TrpcClient, private val json: Json) {

  companion object {
    private const val TAG = "NotesRepository"
  }

  suspend fun list(limit: Int = 100): List<Note> {
    val input = buildJsonObject { put("limit", limit) }
    val result = trpc.query("notes.list", input)
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(Note.serializer(), it) }
    } catch (e: Exception) {
      Log.w(TAG, "list failed", e)
      emptyList()
    }
  }

  suspend fun create(title: String, content: String = "", notebook: String = "General"): String? {
    return try {
      val input = buildJsonObject {
        put("title", title)
        put("content", content)
        put("notebook", notebook)
      }
      val result = trpc.mutate("notes.create", input)
      json.decodeFromJsonElement(NoteCreateResult.serializer(), result).noteId
    } catch (e: Exception) {
      Log.w(TAG, "create failed", e)
      null
    }
  }

  suspend fun update(noteId: String, title: String? = null, content: String? = null): Boolean {
    return try {
      val input = buildJsonObject {
        put("noteId", noteId)
        title?.let { put("title", it) }
        content?.let { put("content", it) }
      }
      trpc.mutate("notes.update", input)
      true
    } catch (e: Exception) {
      Log.w(TAG, "update failed", e)
      false
    }
  }

  suspend fun delete(noteId: String): Boolean {
    return try {
      trpc.mutate("notes.delete", buildJsonObject { put("noteId", noteId) })
      true
    } catch (e: Exception) {
      Log.w(TAG, "delete failed", e)
      false
    }
  }
}
