package com.coherence.healthconnect.ui.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.CalendarEvent

@Composable
fun CalendarWidget(
  events: List<CalendarEvent>,
  isLoading: Boolean,
  error: String? = null,
  lastUpdatedMillis: Long? = null,
  onRetry: (() -> Unit)? = null,
  maxItems: Int = 6,
) {
  WidgetShell(
    title = "Calendar",
    icon = Icons.Default.CalendarMonth,
    category = WidgetCategory.PRODUCTIVITY,
    isLoading = isLoading && events.isEmpty(),
    error = if (events.isEmpty()) error else null,
    onRetry = if (events.isEmpty()) onRetry else null,
    lastUpdated = lastUpdatedMillis,
  ) {
    if (isLoading && events.isEmpty()) {
      Text(
        "Loading events...",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else if (events.isEmpty()) {
      Text(
        "No upcoming events",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        events.take(maxItems).forEach { event ->
          CalendarEventRow(event)
        }
        if (events.size > maxItems) {
          Text(
            "+${events.size - maxItems} more",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 16.dp),
          )
        }
      }
    }
  }
}

@Composable
private fun CalendarEventRow(event: CalendarEvent) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(
      Icons.Default.Circle,
      contentDescription = null,
      modifier = Modifier.size(8.dp),
      tint = MaterialTheme.colorScheme.primary,
    )
    Spacer(modifier = Modifier.width(12.dp))
    Column(modifier = Modifier.weight(1f)) {
      Text(
        text = event.summary ?: "(No title)",
        style = MaterialTheme.typography.bodyMedium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      val timeText = formatEventTime(event)
      if (timeText.isNotBlank()) {
        Text(
          text = timeText,
          style = MaterialTheme.typography.labelSmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }
  }
}

private fun formatEventTime(event: CalendarEvent): String {
  val start = event.start ?: return ""
  // All-day event
  if (start.date != null && start.dateTime == null) {
    return "All day"
  }
  val dt = start.dateTime ?: return ""
  // Extract time portion from ISO string like "2026-03-17T09:00:00-04:00"
  return try {
    val timePart = dt.substringAfter("T").take(5) // "09:00"
    val hour = timePart.substringBefore(":").toInt()
    val min = timePart.substringAfter(":")
    val amPm = if (hour < 12) "AM" else "PM"
    val h12 = if (hour == 0) 12 else if (hour > 12) hour - 12 else hour
    "$h12:$min $amPm"
  } catch (_: Exception) {
    dt.take(16)
  }
}
