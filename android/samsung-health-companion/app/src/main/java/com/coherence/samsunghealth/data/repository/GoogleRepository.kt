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

  suspend fun getCalendarEvents(
    startIso: String? = null,
    endIso: String? = null,
    daysAhead: Int? = null,
    maxResults: Int? = null,
  ): List<CalendarEvent> {
    val hasInput = startIso != null || endIso != null || daysAhead != null || maxResults != null
    val input = if (hasInput) {
      buildJsonObject {
        startIso?.let { put("startIso", it) }
        endIso?.let { put("endIso", it) }
        daysAhead?.let { put("daysAhead", it) }
        maxResults?.let { put("maxResults", it) }
      }
    } else {
      null
    }
    val result = trpc.query("google.getCalendarEvents", input)
    return result.jsonArray.map { json.decodeFromJsonElement(CalendarEvent.serializer(), it) }
  }

  suspend fun getGmailMessages(maxResults: Int = 20): List<GmailMessage> {
    val input = buildJsonObject { put("maxResults", maxResults) }
    val result = trpc.query("google.getGmailMessages", input)
    return result.jsonArray.map { json.decodeFromJsonElement(GmailMessage.serializer(), it) }
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
    val result = trpc.query("google.getDriveFiles")
    return result.jsonArray.map { json.decodeFromJsonElement(DriveFile.serializer(), it) }
  }

  suspend fun searchDrive(query: String): List<DriveFile> {
    val input = buildJsonObject { put("query", query) }
    val result = trpc.query("google.searchDrive", input)
    return result.jsonArray.map { json.decodeFromJsonElement(DriveFile.serializer(), it) }
  }
}
