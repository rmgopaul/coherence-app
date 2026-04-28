package com.coherence.healthconnect.ui.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoGraph
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.ui.LocalApp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Cross-domain insights — Anthropic correlations over 90 days of
 * the user's biology + behavior. Surfaces 0-3 of the most recent
 * cached items on the dashboard with a tap-through to the full
 * InsightsScreen.
 *
 * Pure projection of the `insights.getLatest` tRPC response. The
 * regenerate flow lives in InsightsScreen so the dashboard widget
 * stays glanceable.
 */
@Composable
fun InsightsWidget(onOpenInsights: () -> Unit) {
  val app = LocalApp.current
  val scope = rememberCoroutineScope()
  var loading by remember { mutableStateOf(true) }
  var items by remember { mutableStateOf<List<InsightItemUi>>(emptyList()) }
  var generatedAt by remember { mutableStateOf<String?>(null) }
  var status by remember { mutableStateOf<String?>(null) }
  var errorMsg by remember { mutableStateOf<String?>(null) }

  LaunchedEffect(Unit) {
    scope.launch {
      try {
        val response = app.container.trpcClient.query("insights.getLatest")
        val obj = response as? JsonObject
        val insight = obj?.get("insight") as? JsonObject
        if (insight != null) {
          val itemsJson = insight["items"] as? JsonArray
          items = itemsJson.orEmpty().mapNotNull { it as? JsonObject }.map { o ->
            InsightItemUi(
              title = (o["title"] as? JsonPrimitive)?.contentOrNull ?: "",
              body = (o["body"] as? JsonPrimitive)?.contentOrNull ?: "",
              confidence =
                (o["confidence"] as? JsonPrimitive)?.contentOrNull ?: "medium",
            )
          }.filter { it.title.isNotBlank() }
          generatedAt = (insight["generatedAt"] as? JsonPrimitive)?.contentOrNull
          status = (insight["status"] as? JsonPrimitive)?.contentOrNull
          errorMsg = (insight["errorMessage"] as? JsonPrimitive)?.contentOrNull
        }
      } catch (e: Throwable) {
        errorMsg = e.message
      } finally {
        loading = false
      }
    }
  }

  WidgetShell(
    title = "Patterns this week",
    icon = Icons.Default.AutoGraph,
    category = WidgetCategory.AI,
    isLoading = loading && items.isEmpty(),
    error = if (items.isEmpty()) errorMsg else null,
  ) {
    if (items.isEmpty() && !loading) {
      // Empty / never-generated. Tap-through to the screen handles
      // the regenerate flow + Anthropic-key not-set messaging.
      Text(
        text = if (status == "failed" && !errorMsg.isNullOrBlank())
          "Couldn't generate yet — open insights to retry."
        else
          "No patterns yet. Open insights to scan the last 90 days.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Spacer(modifier = Modifier.padding(top = 4.dp))
      TextButton(onClick = onOpenInsights) {
        Text("Open insights")
      }
      return@WidgetShell
    }

    Column(
      modifier = Modifier.fillMaxWidth(),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      items.take(3).forEach { item -> InsightRow(item) }
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          text = if (items.size > 3) "+${items.size - 3} more in insights" else "",
          style = MaterialTheme.typography.labelSmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = onOpenInsights) {
          Text("See all")
        }
      }
    }
  }
}

private data class InsightItemUi(
  val title: String,
  val body: String,
  val confidence: String,
)

@Composable
private fun InsightRow(item: InsightItemUi) {
  Column(
    modifier = Modifier.fillMaxWidth(),
    verticalArrangement = Arrangement.spacedBy(2.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(
        text = item.title,
        style = MaterialTheme.typography.bodyMedium,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.weight(1f),
      )
      Spacer(modifier = Modifier.width(8.dp))
      ConfidenceChip(item.confidence)
    }
    if (item.body.isNotBlank()) {
      Text(
        text = item.body,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}

@Composable
private fun ConfidenceChip(confidence: String) {
  val label = confidence.replaceFirstChar { it.uppercase() }
  AssistChip(
    onClick = {},
    enabled = false,
    label = {
      Text(
        text = label,
        style = MaterialTheme.typography.labelSmall,
      )
    },
    shape = RoundedCornerShape(8.dp),
    colors = AssistChipDefaults.assistChipColors(),
  )
}
