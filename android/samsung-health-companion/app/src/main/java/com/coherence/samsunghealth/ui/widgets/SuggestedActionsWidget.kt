package com.coherence.samsunghealth.ui.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.data.model.SuggestionItem

@Composable
fun SuggestedActionsWidget(
  suggestions: List<SuggestionItem>,
  onGeneratePlan: () -> Unit,
) {
  WidgetShell(
    title = "Suggested Actions",
    icon = Icons.Default.Bolt,
    category = WidgetCategory.AI,
  ) {
    if (suggestions.isEmpty()) {
      Text(
        text = "No suggestions yet. Refresh to load your latest priorities.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      return@WidgetShell
    }

    Column(
      modifier = Modifier.fillMaxWidth(),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      suggestions.forEach { suggestion ->
        Column(modifier = Modifier.fillMaxWidth()) {
          Text(
            text = suggestion.title,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
          )
          if (!suggestion.reason.isNullOrBlank()) {
            Text(
              text = suggestion.reason,
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
              modifier = Modifier.padding(top = 2.dp),
            )
          }
          if (suggestion.actionType == "generate_plan") {
            Button(
              onClick = onGeneratePlan,
              modifier = Modifier.padding(top = 6.dp),
            ) {
              Text("Generate Plan")
            }
          }
        }
      }
    }
  }
}
