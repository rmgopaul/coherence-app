package com.coherence.healthconnect.ui.widgets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MonitorHeart
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.WhoopSummary

private fun recoveryColor(score: Double): Color = when {
  score >= 67 -> Color(0xFF00C853) // green
  score >= 34 -> Color(0xFFFFAB00) // yellow
  else -> Color(0xFFFF1744)        // red
}

@Composable
fun WhoopWidget(
  summary: WhoopSummary?,
  isLoading: Boolean,
  error: String? = null,
  lastUpdatedMillis: Long? = null,
  onRetry: (() -> Unit)? = null,
) {
  WidgetShell(
    title = "WHOOP",
    icon = Icons.Default.MonitorHeart,
    category = WidgetCategory.HEALTH,
    isLoading = isLoading && summary == null,
    error = if (summary == null) error else null,
    onRetry = if (summary == null) onRetry else null,
    lastUpdated = lastUpdatedMillis,
  ) {
    if (isLoading && summary == null) {
      Text(
        "Loading WHOOP data...",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else if (summary == null) {
      Text(
        "No WHOOP data available",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else {
      // Headline row — Recovery / Strain / Sleep / HRV are the four
      // values WHOOP itself foregrounds. Kept as the at-a-glance row.
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceEvenly,
      ) {
        summary.recoveryScore?.let { score ->
          Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
              modifier = Modifier
                .size(56.dp)
                .clip(CircleShape)
                .background(recoveryColor(score).copy(alpha = 0.15f)),
              contentAlignment = Alignment.Center,
            ) {
              Text(
                text = "${score.toInt()}%",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = recoveryColor(score),
              )
            }
            Text(
              text = "Recovery",
              style = MaterialTheme.typography.labelSmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
              modifier = Modifier.padding(top = 4.dp),
            )
          }
        }

        summary.dayStrain?.let { strain ->
          HeadlineMetric(value = "%.1f".format(strain), label = "Strain")
        }
        summary.sleepHours?.let { hours ->
          HeadlineMetric(value = "%.1f h".format(hours), label = "Sleep")
        }
        summary.hrvRmssdMilli?.let { hrv ->
          HeadlineMetric(value = "${hrv.toInt()} ms", label = "HRV")
        }
      }

      // Full detail grid for every other field WhoopSummary carries.
      // The user explicitly asked for "all available data" — grouped
      // here as Sleep / Cardio / Activity sections so the dump stays
      // legible. Each entry is gated on its field being non-null.
      val sleepDetails = buildList {
        summary.sleepPerformance?.let { add("Sleep performance" to "%.0f%%".format(it)) }
        summary.sleepEfficiency?.let { add("Sleep efficiency" to "%.0f%%".format(it)) }
        summary.sleepConsistency?.let { add("Sleep consistency" to "%.0f%%".format(it)) }
        summary.timeInBedHours?.let { add("Time in bed" to "%.1f h".format(it)) }
        summary.lightSleepHours?.let { add("Light sleep" to "%.1f h".format(it)) }
        summary.deepSleepHours?.let { add("Deep sleep" to "%.1f h".format(it)) }
        summary.remSleepHours?.let { add("REM sleep" to "%.1f h".format(it)) }
        summary.awakeHours?.let { add("Awake in bed" to "%.1f h".format(it)) }
      }
      val cardioDetails = buildList {
        summary.restingHeartRate?.let { add("Resting HR" to "${it.toInt()} bpm") }
        summary.averageHeartRate?.let { add("Avg HR" to "${it.toInt()} bpm") }
        summary.maxHeartRate?.let { add("Max HR" to "${it.toInt()} bpm") }
        summary.respiratoryRate?.let { add("Respiratory rate" to "%.1f /min".format(it)) }
        summary.spo2Percentage?.let { add("SpO2" to "%.1f%%".format(it)) }
        summary.skinTempCelsius?.let { add("Skin temp" to "%.1f°C".format(it)) }
      }
      val activityDetails = buildList {
        summary.steps?.let { add("Steps" to "%,d".format(it)) }
        summary.kilojoule?.let { add("Energy burned" to "%.0f kJ".format(it)) }
        summary.latestWorkoutStrain?.let { add("Last workout strain" to "%.1f".format(it)) }
      }

      if (sleepDetails.isNotEmpty()) {
        Spacer(Modifier.height(12.dp))
        SectionLabel("Sleep")
        DetailGrid(sleepDetails)
      }
      if (cardioDetails.isNotEmpty()) {
        Spacer(Modifier.height(8.dp))
        SectionLabel("Cardio")
        DetailGrid(cardioDetails)
      }
      if (activityDetails.isNotEmpty()) {
        Spacer(Modifier.height(8.dp))
        SectionLabel("Activity")
        DetailGrid(activityDetails)
      }
    }
  }
}

@Composable
private fun HeadlineMetric(value: String, label: String) {
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Text(
      text = value,
      style = MaterialTheme.typography.titleMedium,
      fontWeight = FontWeight.Bold,
    )
    Text(
      text = label,
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}

@Composable
private fun SectionLabel(text: String) {
  Text(
    text = text,
    style = MaterialTheme.typography.labelSmall,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
    fontWeight = FontWeight.SemiBold,
    modifier = Modifier.padding(bottom = 4.dp),
  )
}
