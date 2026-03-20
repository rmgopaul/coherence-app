package com.coherence.samsunghealth.data.model

import kotlinx.serialization.Serializable

// ── Auth ──

@Serializable
data class User(
  val id: Int,
  val openId: String,
  val name: String? = null,
  val email: String? = null,
  val loginMethod: String? = null,
  val role: String = "user",
)

// ── Integrations ──

@Serializable
data class Integration(
  val id: String,
  val provider: String,
  val scope: String? = null,
)

// ── Todoist ──

@Serializable
data class TodoistDue(
  val date: String,
  val datetime: String? = null,
  val string: String = "",
)

@Serializable
data class TodoistTask(
  val id: String,
  val content: String,
  val description: String = "",
  val projectId: String = "",
  val parentId: String? = null,
  val priority: Int = 1,
  val labels: List<String> = emptyList(),
  val due: TodoistDue? = null,
)

@Serializable
data class TodoistProject(
  val id: String,
  val name: String,
  val color: String = "",
)

// ── Google Calendar ──

@Serializable
data class CalendarDateTime(
  val dateTime: String? = null,
  val date: String? = null,
  val timeZone: String? = null,
)

@Serializable
data class CalendarEvent(
  val id: String? = null,
  val summary: String? = null,
  val description: String? = null,
  val location: String? = null,
  val start: CalendarDateTime? = null,
  val end: CalendarDateTime? = null,
  val status: String? = null,
  val htmlLink: String? = null,
)

// ── Gmail ──

@Serializable
data class GmailHeader(
  val name: String,
  val value: String,
)

@Serializable
data class GmailPayload(
  val headers: List<GmailHeader> = emptyList(),
)

@Serializable
data class GmailMessage(
  val id: String,
  val threadId: String = "",
  val labelIds: List<String> = emptyList(),
  val internalDate: String? = null,
  val snippet: String = "",
  val payload: GmailPayload? = null,
) {
  val subject: String
    get() = payload?.headers?.firstOrNull { it.name.equals("Subject", ignoreCase = true) }?.value ?: "(no subject)"

  val from: String
    get() = payload?.headers?.firstOrNull { it.name.equals("From", ignoreCase = true) }?.value ?: ""

  val date: String
    get() = payload?.headers?.firstOrNull { it.name.equals("Date", ignoreCase = true) }?.value ?: ""

  val isUnread: Boolean
    get() = labelIds.contains("UNREAD")
}

// ── WHOOP ──

@Serializable
data class WhoopSummary(
  val dataDate: String? = null,
  val recoveryScore: Double? = null,
  val restingHeartRate: Double? = null,
  val hrvRmssdMilli: Double? = null,
  val spo2Percentage: Double? = null,
  val skinTempCelsius: Double? = null,
  val respiratoryRate: Double? = null,
  val sleepPerformance: Double? = null,
  val sleepConsistency: Double? = null,
  val sleepEfficiency: Double? = null,
  val sleepHours: Double? = null,
  val timeInBedHours: Double? = null,
  val lightSleepHours: Double? = null,
  val deepSleepHours: Double? = null,
  val remSleepHours: Double? = null,
  val awakeHours: Double? = null,
  val dayStrain: Double? = null,
  val steps: Int? = null,
  val averageHeartRate: Double? = null,
  val maxHeartRate: Double? = null,
  val kilojoule: Double? = null,
  val latestWorkoutStrain: Double? = null,
  val updatedAt: String? = null,
)

// ── Google Drive ──

@Serializable
data class DriveFile(
  val id: String,
  val name: String,
  val mimeType: String = "",
  val modifiedTime: String? = null,
  val webViewLink: String? = null,
  val iconLink: String? = null,
  val trashed: Boolean = false,
)

// ── Clockify ──

@Serializable
data class ClockifyStatus(
  val connected: Boolean = false,
  val workspaceId: String? = null,
  val workspaceName: String? = null,
  val userId: String? = null,
  val userName: String? = null,
  val userEmail: String? = null,
)

@Serializable
data class ClockifyTimeEntry(
  val id: String,
  val description: String = "",
  val projectId: String? = null,
  val projectName: String? = null,
  val taskId: String? = null,
  val start: String? = null,
  val end: String? = null,
  val duration: String? = null,
  val durationSeconds: Long? = null,
  val isRunning: Boolean = false,
  val tagIds: List<String> = emptyList(),
)

@Serializable
data class ClockifyStopResult(
  val success: Boolean = false,
  val stopped: Boolean = false,
)

// ── Samsung Health (local display) ──

@Serializable
data class SamsungHealthDisplay(
  val sleepTotalMinutes: Int? = null,
  val energyScore: Int? = null,
  val steps: Int? = null,
  val activeCalories: Double? = null,
  val heartRateAvg: Int? = null,
)
