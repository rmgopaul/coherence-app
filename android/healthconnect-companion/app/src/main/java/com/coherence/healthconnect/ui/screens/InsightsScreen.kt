package com.coherence.healthconnect.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
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
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Full insights surface — lists the most recent AI-generated
 * cross-domain correlations with metadata (range, days analyzed,
 * model) and a regenerate button.
 *
 * Backed by the `insights.getLatest` query (cheap; called on entry)
 * and the `insights.generate` mutation (Anthropic-bound; only fires
 * on explicit user action).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InsightsScreen(onBack: () -> Unit) {
  val app = LocalApp.current
  val scope = rememberCoroutineScope()

  var loading by remember { mutableStateOf(true) }
  var generating by remember { mutableStateOf(false) }
  var insight by remember { mutableStateOf<InsightDetail?>(null) }
  var loadError by remember { mutableStateOf<String?>(null) }
  var generateError by remember { mutableStateOf<String?>(null) }

  fun load() {
    scope.launch {
      loading = true
      loadError = null
      try {
        val response = app.container.trpcClient.query("insights.getLatest")
        insight = parseInsight(response as? JsonObject)
      } catch (e: Throwable) {
        loadError = e.message
      } finally {
        loading = false
      }
    }
  }

  LaunchedEffect(Unit) { load() }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Patterns") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
          }
        },
        actions = {
          IconButton(onClick = { load() }) {
            Icon(Icons.Default.Refresh, contentDescription = "Reload")
          }
        },
      )
    },
  ) { padding ->
    LazyColumn(
      modifier = Modifier.fillMaxSize().padding(padding),
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      if (loading && insight == null) {
        item {
          Column(
            modifier = Modifier.fillMaxWidth().padding(48.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
          ) {
            CircularProgressIndicator()
            Text(
              "Loading insights…",
              style = MaterialTheme.typography.bodyMedium,
              modifier = Modifier.padding(top = 16.dp),
            )
          }
        }
        return@LazyColumn
      }

      val current = insight
      if (current == null) {
        item {
          Card {
            Column(
              modifier = Modifier.fillMaxWidth().padding(20.dp),
              verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
              Text(
                "No insights yet",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
              )
              Text(
                "Tap Generate to scan your last 90 days of supplements, habits, sleep, recovery, and reflections for correlations. Needs Claude connected in Settings + at least 14 days of overlapping data.",
                style = MaterialTheme.typography.bodyMedium,
              )
              if (!loadError.isNullOrBlank()) {
                Text(
                  text = "Error: $loadError",
                  style = MaterialTheme.typography.bodySmall,
                  color = MaterialTheme.colorScheme.error,
                )
              }
              GenerateButton(
                generating = generating,
                generateError = generateError,
                onGenerate = {
                  generating = true
                  generateError = null
                  scope.launch {
                    try {
                      app.container.trpcClient.mutate("insights.generate")
                      load()
                    } catch (e: Throwable) {
                      generateError = e.message ?: "Generate failed."
                    } finally {
                      generating = false
                    }
                  }
                },
              )
            }
          }
        }
        return@LazyColumn
      }

      item {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text(
            text = "${current.daysAnalyzed} days analyzed · ${current.rangeStartKey} → ${current.rangeEndKey}",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = FontWeight.SemiBold,
          )
          Text(
            text = "Generated ${current.generatedAt.take(10)} · ${current.model}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      }

      if (current.status == "failed" && !current.errorMessage.isNullOrBlank()) {
        item {
          Card(
            colors = CardDefaults.cardColors(
              containerColor = MaterialTheme.colorScheme.errorContainer,
            ),
          ) {
            Column(
              modifier = Modifier.fillMaxWidth().padding(16.dp),
              verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
              Text(
                "Last generation failed",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onErrorContainer,
              )
              Text(
                current.errorMessage,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
              )
            }
          }
        }
      }

      if (current.items.isEmpty() && current.status != "failed") {
        item {
          Text(
            "Anthropic didn't surface meaningful correlations from this window. More variation in supplements / habits / reflections will help.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      }

      items_for_insights(current.items)

      item {
        GenerateButton(
          generating = generating,
          generateError = generateError,
          label = "Regenerate",
          onGenerate = {
            generating = true
            generateError = null
            scope.launch {
              try {
                app.container.trpcClient.mutate("insights.generate")
                load()
              } catch (e: Throwable) {
                generateError = e.message ?: "Generate failed."
              } finally {
                generating = false
              }
            }
          },
        )
      }
    }
  }
}

private fun androidx.compose.foundation.lazy.LazyListScope.items_for_insights(
  items: List<InsightItemDetail>,
) {
  items.forEach { item ->
    item {
      Card(
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
      ) {
        Column(
          modifier = Modifier.fillMaxWidth().padding(16.dp),
          verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
              text = item.title,
              style = MaterialTheme.typography.titleSmall,
              fontWeight = FontWeight.Bold,
              modifier = Modifier.weight(1f),
            )
            AssistChip(
              onClick = {},
              enabled = false,
              label = {
                Text(
                  item.confidence.replaceFirstChar { it.uppercase() },
                  style = MaterialTheme.typography.labelSmall,
                )
              },
              colors = AssistChipDefaults.assistChipColors(),
            )
          }
          if (item.body.isNotBlank()) {
            Text(
              text = item.body,
              style = MaterialTheme.typography.bodyMedium,
            )
          }
        }
      }
    }
  }
}

@Composable
private fun GenerateButton(
  generating: Boolean,
  generateError: String?,
  label: String = "Generate insights",
  onGenerate: () -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    OutlinedButton(
      onClick = onGenerate,
      enabled = !generating,
      modifier = Modifier.fillMaxWidth(),
    ) {
      Text(if (generating) "Generating…" else label)
    }
    if (!generateError.isNullOrBlank()) {
      Text(
        "Error: $generateError",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
      )
    }
  }
}

private data class InsightDetail(
  val id: String,
  val dateKey: String,
  val rangeStartKey: String,
  val rangeEndKey: String,
  val generatedAt: String,
  val model: String,
  val daysAnalyzed: Int,
  val status: String,
  val errorMessage: String?,
  val items: List<InsightItemDetail>,
)

private data class InsightItemDetail(
  val title: String,
  val body: String,
  val confidence: String,
)

private fun parseInsight(obj: JsonObject?): InsightDetail? {
  if (obj == null) return null
  val insight = obj["insight"] as? JsonObject ?: return null
  val itemsJson = insight["items"] as? JsonArray
  val items = itemsJson.orEmpty().mapNotNull { it as? JsonObject }.map { o ->
    InsightItemDetail(
      title = (o["title"] as? JsonPrimitive)?.contentOrNull ?: "",
      body = (o["body"] as? JsonPrimitive)?.contentOrNull ?: "",
      confidence = (o["confidence"] as? JsonPrimitive)?.contentOrNull ?: "medium",
    )
  }.filter { it.title.isNotBlank() }
  return InsightDetail(
    id = (insight["id"] as? JsonPrimitive)?.contentOrNull ?: "",
    dateKey = (insight["dateKey"] as? JsonPrimitive)?.contentOrNull ?: "",
    rangeStartKey = (insight["rangeStartKey"] as? JsonPrimitive)?.contentOrNull ?: "",
    rangeEndKey = (insight["rangeEndKey"] as? JsonPrimitive)?.contentOrNull ?: "",
    generatedAt = (insight["generatedAt"] as? JsonPrimitive)?.contentOrNull ?: "",
    model = (insight["model"] as? JsonPrimitive)?.contentOrNull ?: "",
    daysAnalyzed = insight["daysAnalyzed"]?.jsonPrimitive?.intOrNull ?: 0,
    status = (insight["status"] as? JsonPrimitive)?.contentOrNull ?: "",
    errorMessage = (insight["errorMessage"] as? JsonPrimitive)?.contentOrNull,
    items = items,
  )
}
