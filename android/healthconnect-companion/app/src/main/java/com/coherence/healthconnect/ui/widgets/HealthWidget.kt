package com.coherence.healthconnect.ui.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.SamsungHealthDisplay

@Composable
fun HealthWidget(
  healthData: SamsungHealthDisplay?,
  isLoading: Boolean,
  error: String? = null,
  lastUpdatedMillis: Long? = null,
  onRetry: (() -> Unit)? = null,
) {
  WidgetShell(
    title = "Samsung Health",
    icon = Icons.Default.FavoriteBorder,
    category = WidgetCategory.HEALTH,
    isLoading = isLoading && healthData == null,
    error = if (healthData == null) error else null,
    onRetry = if (healthData == null) onRetry else null,
    lastUpdated = lastUpdatedMillis,
  ) {
    if (isLoading && healthData == null) {
      Text(
        "Loading health data...",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else if (healthData == null) {
      Text(
        "No health data available",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else {
      // Headline row — the user's "at a glance" metrics. Sleep + steps
      // anchor the row even when the optional fields are absent.
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceEvenly,
      ) {
        healthData.sleepTotalMinutes?.let {
          MetricItem("Sleep", formatSleep(it))
        }
        healthData.steps?.let {
          MetricItem("Steps", "%,d".format(it))
        }
        healthData.heartRateAvg?.let {
          MetricItem("Avg HR", "$it bpm")
        }
        healthData.activeCalories?.let {
          MetricItem("Calories", "${it.toInt()} cal")
        }
      }

      // Detail grid — anything available beyond the headlines.
      // 2-column layout matches the markets card and reduces the
      // wasted whitespace the user called out. Each entry is gated on
      // its source field being non-null so a missing watch doesn't
      // leave empty placeholder cells.
      val details = buildList {
        healthData.sleepScore?.let { add("Sleep score" to it.toString()) }
        healthData.energyScore?.let { add("Energy score" to it.toString()) }
        healthData.spo2AvgPercent?.let {
          if (it > 0) add("SpO2 avg" to "%.1f%%".format(it))
        }
      }

      if (details.isNotEmpty()) {
        Spacer(Modifier.height(12.dp))
        DetailGrid(details)
      }
    }
  }
}

@Composable
private fun MetricItem(label: String, value: String) {
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

/**
 * Generic 2-column label/value detail grid. Reused by both the Samsung
 * and WHOOP cards for the "all the rest of the data" rows below the
 * headline metrics.
 */
@Composable
internal fun DetailGrid(entries: List<Pair<String, String>>) {
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    entries.chunked(2).forEach { pair ->
      Row(modifier = Modifier.fillMaxWidth()) {
        DetailCell(pair[0].first, pair[0].second, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(12.dp))
        if (pair.size == 2) {
          DetailCell(pair[1].first, pair[1].second, modifier = Modifier.weight(1f))
        } else {
          Spacer(Modifier.weight(1f))
        }
      }
    }
  }
}

@Composable
private fun DetailCell(label: String, value: String, modifier: Modifier = Modifier) {
  Column(modifier = modifier) {
    Text(
      text = label,
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Text(
      text = value,
      style = MaterialTheme.typography.bodyMedium,
      fontWeight = FontWeight.SemiBold,
    )
  }
}

private fun formatSleep(minutes: Int): String {
  val h = minutes / 60
  val m = minutes % 60
  return "${h}h ${m}m"
}
