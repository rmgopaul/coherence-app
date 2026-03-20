package com.coherence.samsunghealth.ui.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.data.model.SamsungHealthDisplay

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

private fun formatSleep(minutes: Int): String {
  val h = minutes / 60
  val m = minutes % 60
  return "${h}h ${m}m"
}
