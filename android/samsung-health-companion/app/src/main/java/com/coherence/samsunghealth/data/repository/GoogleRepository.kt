package com.coherence.samsunghealth.data.repository

import com.coherence.samsunghealth.data.model.CalendarEvent
import com.coherence.samsunghealth.data.model.DriveFile
import com.coherence.samsunghealth.data.model.GmailMessage
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put

class GoogleRepository(private val trpc: TrpcClient) {

  private val json = Json { ignoreUnknownKeys = true }

  suspend fun getCalendarEvents(): List<CalendarEvent> {
    val result = trpc.query("google.getCalendarEvents")
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(CalendarEvent.serializer(), it) }
    } catch (_: Exception) {
      emptyList()
    }
  }

  suspend fun getGmailMessages(maxResults: Int = 20): List<GmailMessage> {
    val input = buildJsonObject { put("maxResults", maxResults) }
    val result = trpc.query("google.getGmailMessages", input)
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(GmailMessage.serializer(), it) }
    } catch (_: Exception) {
      emptyList()
    }
  }

  suspend fun markGmailAsRead(messageId: String): Boolean {
    return try {
      val input = buildJsonObject { put("messageId", messageId) }
      trpc.mutate("google.markGmailAsRead", input)
      true
    } catch (_: Exception) {
      false
    }
  }

  suspend fun getDriveFiles(): List<DriveFile> {
    return try {
      val result = trpc.query("google.getDriveFiles")
      result.jsonArray.map { json.decodeFromJsonElement(DriveFile.serializer(), it) }
    } catch (_: Exception) {
      emptyList()
    }
  }

  suspend fun searchDrive(query: String): List<DriveFile> {
    return try {
      val input = buildJsonObject { put("query", query) }
      val result = trpc.query("google.searchDrive", input)
      result.jsonArray.map { json.decodeFromJsonElement(DriveFile.serializer(), it) }
    } catch (_: Exception) {
      emptyList()
    }
  }
}
