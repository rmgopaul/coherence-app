package com.coherence.samsunghealth.ui.widgets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
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
import com.coherence.samsunghealth.data.model.WhoopSummary

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
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceEvenly,
      ) {
        // Recovery Score (highlight)
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

        // Strain
        summary.dayStrain?.let { strain ->
          Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
              text = "%.1f".format(strain),
              style = MaterialTheme.typography.titleMedium,
              fontWeight = FontWeight.Bold,
            )
            Text(
              text = "Strain",
              style = MaterialTheme.typography.labelSmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
        }

        // Sleep
        summary.sleepHours?.let { hours ->
          Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
              text = "%.1f h".format(hours),
              style = MaterialTheme.typography.titleMedium,
              fontWeight = FontWeight.Bold,
            )
            Text(
              text = "Sleep",
              style = MaterialTheme.typography.labelSmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
        }

        // HRV
        summary.hrvRmssdMilli?.let { hrv ->
          Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
              text = "${hrv.toInt()} ms",
              style = MaterialTheme.typography.titleMedium,
              fontWeight = FontWeight.Bold,
            )
            Text(
              text = "HRV",
              style = MaterialTheme.typography.labelSmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
        }
      }
    }
  }
}
