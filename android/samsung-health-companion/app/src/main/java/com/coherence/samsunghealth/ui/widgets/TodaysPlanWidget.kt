package com.coherence.samsunghealth.ui.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun TodaysPlanWidget(
  overview: String?,
  isGenerating: Boolean,
  error: String?,
  onGenerate: () -> Unit,
) {
  WidgetShell(title = "Today's Plan", icon = Icons.Default.AutoAwesome, category = WidgetCategory.AI) {
    if (overview != null) {
      RichText(
        text = overview,
        modifier = Modifier.fillMaxWidth(),
      )
      Button(
        onClick = onGenerate,
        modifier = Modifier.padding(top = 12.dp),
        enabled = !isGenerating,
        colors = ButtonDefaults.textButtonColors(),
      ) {
        Text(if (isGenerating) "Regenerating..." else "Regenerate")
      }
    } else if (isGenerating) {
      Text(
        text = "Generating your daily plan... This may take up to 30 seconds.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
          text = "Get an AI-generated plan for your day based on your tasks, calendar, and emails.",
          style = MaterialTheme.typography.bodyMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (error != null) {
          Text(
            text = error,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
          )
        }
        Button(onClick = onGenerate) {
          Text("Generate Plan")
        }
      }
    }
  }
}
