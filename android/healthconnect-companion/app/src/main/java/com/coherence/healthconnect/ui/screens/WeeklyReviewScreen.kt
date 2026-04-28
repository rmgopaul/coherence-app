package com.coherence.healthconnect.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
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
import com.coherence.healthconnect.ui.widgets.RichText
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Renders the AI-generated weekly review for the user. Server side
 * (`weeklyReview.getLatest`) is already shipped — this screen is the
 * Android surface for it; the web app surfaces the same endpoint via
 * `WeeklyReviewCard.tsx`.
 *
 * When `status = pending` we show a spinner + "generating now" copy
 * and poll lightly. When `status = ready` we render `headline` +
 * `contentMarkdown` (Markdown-ish; reuses the existing RichText
 * composable that already powers Notes). When `status = failed` we
 * show a regenerate button that hits `weeklyReview.regenerate`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WeeklyReviewScreen(onBack: () -> Unit) {
  val app = LocalApp.current
  val scope = rememberCoroutineScope()

  var loading by remember { mutableStateOf(true) }
  var review by remember { mutableStateOf<JsonObject?>(null) }
  var loadError by remember { mutableStateOf<String?>(null) }
  var regenerating by remember { mutableStateOf(false) }

  fun fetch() {
    scope.launch {
      loading = true
      loadError = null
      try {
        val response = app.container.trpcClient.query("weeklyReview.getLatest")
        review = response as? JsonObject
      } catch (e: Throwable) {
        loadError = e.message ?: "Failed to load weekly review"
      } finally {
        loading = false
      }
    }
  }

  LaunchedEffect(Unit) { fetch() }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("This week") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
          }
        },
        actions = {
          IconButton(onClick = { fetch() }) {
            Icon(Icons.Default.Refresh, contentDescription = "Refresh")
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
      if (loading && review == null) {
        item {
          Column(
            modifier = Modifier.fillMaxWidth().padding(48.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
          ) {
            CircularProgressIndicator()
            Text(
              "Loading your week…",
              style = MaterialTheme.typography.bodyMedium,
              modifier = Modifier.padding(top = 16.dp),
            )
          }
        }
        return@LazyColumn
      }

      val r = review
      if (r == null) {
        item {
          EmptyStateCard(
            title = "No review yet",
            body = "The first weekly review will land Sunday evening once you have at least 3 days of data this week — sleep, tasks, supplements, habits all flow into it.",
            error = loadError,
          )
        }
        return@LazyColumn
      }

      val status = (r["status"] as? JsonPrimitive)?.contentOrNull
      val headline = (r["headline"] as? JsonPrimitive)?.contentOrNull
      val content = (r["contentMarkdown"] as? JsonPrimitive)?.contentOrNull
      val weekKey = (r["weekKey"] as? JsonPrimitive)?.contentOrNull
      val errorMessage = (r["errorMessage"] as? JsonPrimitive)?.contentOrNull
      val daysWithData = (r["daysWithData"] as? JsonPrimitive)?.contentOrNull?.toIntOrNull() ?: 0

      item {
        Text(
          text = weekKey ?: "Latest review",
          style = MaterialTheme.typography.labelMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          fontWeight = FontWeight.Bold,
        )
      }

      when (status) {
        "pending" -> item {
          Card {
            Column(
              modifier = Modifier.fillMaxWidth().padding(16.dp),
              verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
              Text("Generating…", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
              Text(
                "Anthropic is summarizing $daysWithData days of data. Check back in a minute.",
                style = MaterialTheme.typography.bodyMedium,
              )
              CircularProgressIndicator(modifier = Modifier.padding(top = 8.dp))
            }
          }
        }
        "failed" -> item {
          Card(
            colors = CardDefaults.cardColors(
              containerColor = MaterialTheme.colorScheme.errorContainer,
            ),
          ) {
            Column(
              modifier = Modifier.fillMaxWidth().padding(16.dp),
              verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
              Text(
                "Generation failed",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onErrorContainer,
              )
              if (!errorMessage.isNullOrBlank()) {
                Text(
                  errorMessage,
                  style = MaterialTheme.typography.bodySmall,
                  color = MaterialTheme.colorScheme.onErrorContainer,
                )
              }
              OutlinedButton(
                enabled = !regenerating && weekKey != null,
                onClick = {
                  if (weekKey == null) return@OutlinedButton
                  regenerating = true
                  scope.launch {
                    try {
                      app.container.trpcClient.mutate(
                        "weeklyReview.regenerate",
                        buildJsonObject { put("weekKey", JsonPrimitive(weekKey)) },
                      )
                      fetch()
                    } catch (_: Throwable) {
                    } finally {
                      regenerating = false
                    }
                  }
                },
              ) {
                Text(if (regenerating) "Regenerating…" else "Try again")
              }
            }
          }
        }
        "ready" -> {
          if (!headline.isNullOrBlank()) {
            item {
              Text(
                text = headline,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
              )
            }
          }
          if (!content.isNullOrBlank()) {
            item {
              RichText(text = content, modifier = Modifier.fillMaxWidth())
            }
          }
        }
        else -> item {
          Text(
            text = "Unknown review status: $status",
            style = MaterialTheme.typography.bodyMedium,
          )
        }
      }
    }
  }
}

@Composable
private fun EmptyStateCard(title: String, body: String, error: String?) {
  Card {
    Column(
      modifier = Modifier.fillMaxWidth().padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      Text(body, style = MaterialTheme.typography.bodyMedium)
      if (!error.isNullOrBlank()) {
        Text(
          "Error: $error",
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.error,
        )
      }
    }
  }
}
