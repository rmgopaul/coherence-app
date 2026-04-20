package com.coherence.healthconnect.ui.widgets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.ClockifyTimeEntry
import kotlinx.coroutines.delay
import java.time.Instant

@Composable
fun ClockifyTimerStrip(
  entry: ClockifyTimeEntry?,
  modifier: Modifier = Modifier,
) {
  val running = entry?.isRunning == true
  var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }

  LaunchedEffect(running, entry?.id) {
    if (!running) return@LaunchedEffect
    while (true) {
      nowMs = System.currentTimeMillis()
      delay(1_000L)
    }
  }

  val elapsedSeconds = remember(entry, running, nowMs) {
    when {
      entry == null -> 0L
      running -> {
        val startMs = parseIsoMillis(entry.start)
        if (startMs != null) ((nowMs - startMs) / 1_000L).coerceAtLeast(0L)
        else (entry.durationSeconds ?: 0L).coerceAtLeast(0L)
      }
      else -> (entry.durationSeconds ?: 0L).coerceAtLeast(0L)
    }
  }

  val statusColor = if (running) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
  val summary = when {
    entry == null -> "No active timer"
    else -> entry.description.ifBlank { "Untitled task" }
  }
  val projectLabel = entry?.projectName?.takeIf { it.isNotBlank() } ?: "No project"

  Row(
    modifier = modifier
      .fillMaxWidth()
      .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))
      .padding(horizontal = 12.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Icon(
      imageVector = Icons.Default.Timer,
      contentDescription = null,
      tint = statusColor,
    )
    Column(modifier = Modifier.weight(1f)) {
      Text(
        text = summary,
        style = MaterialTheme.typography.bodyMedium,
        maxLines = 1,
      )
      Text(
        text = "Project: $projectLabel",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
      )
    }
    Spacer(modifier = Modifier.width(2.dp))
    Text(
      text = formatDuration(elapsedSeconds),
      style = MaterialTheme.typography.titleMedium,
      color = statusColor,
    )
  }
}

private fun parseIsoMillis(value: String?): Long? {
  if (value.isNullOrBlank()) return null
  return runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
}

private fun formatDuration(seconds: Long): String {
  val h = seconds / 3_600L
  val m = (seconds % 3_600L) / 60L
  val s = seconds % 60L
  return "$h:%02d:%02d".format(m, s)
}
