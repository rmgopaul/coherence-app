package com.coherence.healthconnect.ui.screens

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.ui.LocalApp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Evening reflection — the user's nightly close-the-day journal.
 *
 * Four prompts:
 *   - Energy 1-10 (slider) — fastest input, fuels Trends correlations
 *   - What went well (long-form)
 *   - What didn't go (long-form)
 *   - Tomorrow's one thing — seeds the next morning's KoD candidate
 *
 * Idempotent on (userId, dateKey) via the server's `upsertReflection`,
 * so the user can refine the entry across the evening without losing
 * earlier text. On first open we fetch any existing entry for today
 * to pre-populate.
 *
 * Below the save button we list the trailing 30 nights via
 * `reflections.getRecent` so the user can browse history without
 * leaving the screen. Each row is collapsed to (date · energy) until
 * tapped to expand the three prompts.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReflectionScreen(onBack: () -> Unit) {
  val app = LocalApp.current
  val scope = rememberCoroutineScope()

  var energyLevel by remember { mutableStateOf(7f) }
  var wentWell by remember { mutableStateOf("") }
  var didntGo by remember { mutableStateOf("") }
  var tomorrowOneThing by remember { mutableStateOf("") }
  var saving by remember { mutableStateOf(false) }
  var savedAt by remember { mutableStateOf<String?>(null) }
  var loadError by remember { mutableStateOf<String?>(null) }
  var history by remember { mutableStateOf<List<ReflectionRow>>(emptyList()) }
  var historyError by remember { mutableStateOf<String?>(null) }
  var historyLoading by remember { mutableStateOf(true) }
  var refreshKey by remember { mutableStateOf(0) }
  val todayKey = remember { LocalDate.now().format(DateTimeFormatter.ISO_LOCAL_DATE) }

  // Pre-populate today + load history on entry. Re-keyed by saves so
  // a successful upsert immediately reflects in the history list.
  LaunchedEffect(refreshKey) {
    try {
      val response = app.container.trpcClient.query("reflections.getToday")
      val obj = response as? JsonObject ?: return@LaunchedEffect
      val reflection = obj["reflection"] as? JsonObject
      if (reflection != null) {
        reflection["energyLevel"]?.jsonPrimitive?.intOrNull?.let { energyLevel = it.toFloat() }
        (reflection["wentWell"] as? JsonPrimitive)?.contentOrNull?.let { wentWell = it }
        (reflection["didntGo"] as? JsonPrimitive)?.contentOrNull?.let { didntGo = it }
        (reflection["tomorrowOneThing"] as? JsonPrimitive)?.contentOrNull?.let { tomorrowOneThing = it }
      }
    } catch (e: Throwable) {
      loadError = e.message
    }
  }

  LaunchedEffect(refreshKey) {
    historyLoading = true
    historyError = null
    try {
      val response = app.container.trpcClient.query(
        "reflections.getRecent",
        buildJsonObject { put("limit", JsonPrimitive(30)) },
      )
      val arr = response as? JsonArray ?: return@LaunchedEffect
      history = arr.mapNotNull { it as? JsonObject }.map { obj ->
        ReflectionRow(
          dateKey = (obj["dateKey"] as? JsonPrimitive)?.contentOrNull ?: "",
          energyLevel = obj["energyLevel"]?.jsonPrimitive?.intOrNull,
          wentWell = (obj["wentWell"] as? JsonPrimitive)?.contentOrNull,
          didntGo = (obj["didntGo"] as? JsonPrimitive)?.contentOrNull,
          tomorrowOneThing = (obj["tomorrowOneThing"] as? JsonPrimitive)?.contentOrNull,
        )
      }.filter { it.dateKey.isNotEmpty() }
    } catch (e: Throwable) {
      historyError = e.message
    } finally {
      historyLoading = false
    }
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Tonight's reflection") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
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
      item {
        Text(
          text = "Close the day — these answers feed Trends, the weekly review, and tomorrow's King of the Day.",
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }

      item {
        Column {
          Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
          ) {
            Text("Energy today", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium)
            Text(
              "${energyLevel.toInt()} / 10",
              style = MaterialTheme.typography.titleMedium,
              fontWeight = FontWeight.Bold,
              color = energyColor(energyLevel.toInt()),
            )
          }
          Slider(
            value = energyLevel,
            onValueChange = { energyLevel = it },
            valueRange = 1f..10f,
            steps = 8,
          )
        }
      }

      item {
        OutlinedTextField(
          value = wentWell,
          onValueChange = { wentWell = it },
          label = { Text("What went well?") },
          modifier = Modifier.fillMaxWidth().height(120.dp),
          keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
        )
      }

      item {
        OutlinedTextField(
          value = didntGo,
          onValueChange = { didntGo = it },
          label = { Text("What didn't go?") },
          modifier = Modifier.fillMaxWidth().height(120.dp),
          keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
        )
      }

      item {
        OutlinedTextField(
          value = tomorrowOneThing,
          onValueChange = { tomorrowOneThing = it },
          label = { Text("Tomorrow's one thing") },
          placeholder = { Text("If nothing else gets done, this gets done.") },
          modifier = Modifier.fillMaxWidth().height(96.dp),
          keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        )
      }

      item {
        Button(
          onClick = {
            saving = true
            scope.launch {
              try {
                val input = buildJsonObject {
                  put("energyLevel", JsonPrimitive(energyLevel.toInt()))
                  put(
                    "wentWell",
                    if (wentWell.isBlank()) JsonNull else JsonPrimitive(wentWell.trim()),
                  )
                  put(
                    "didntGo",
                    if (didntGo.isBlank()) JsonNull else JsonPrimitive(didntGo.trim()),
                  )
                  put(
                    "tomorrowOneThing",
                    if (tomorrowOneThing.isBlank()) JsonNull else JsonPrimitive(tomorrowOneThing.trim()),
                  )
                }
                app.container.trpcClient.mutate("reflections.upsertToday", input)
                savedAt = "Saved · ${java.text.SimpleDateFormat("h:mm a").format(java.util.Date())}"
                refreshKey += 1
              } catch (e: Throwable) {
                savedAt = "Save failed: ${e.message?.take(80)}"
              } finally {
                saving = false
              }
            }
          },
          enabled = !saving,
          modifier = Modifier.fillMaxWidth(),
        ) {
          Text(if (saving) "Saving…" else "Save reflection")
        }
        savedAt?.let {
          Text(
            text = it,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp),
          )
        }
        loadError?.let {
          Text(
            text = "Couldn't load existing entry: $it",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(top = 4.dp),
          )
        }
      }

      // Past nights — collapsed by default, tap to expand. Excludes
      // today since it's already shown via the form above.
      val pastNights = history.filter { it.dateKey != todayKey }
      item {
        Text(
          text = "Past nights",
          style = MaterialTheme.typography.titleMedium,
          fontWeight = FontWeight.Bold,
          modifier = Modifier.padding(top = 16.dp),
        )
      }
      if (historyLoading && pastNights.isEmpty()) {
        item {
          Text(
            "Loading…",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      } else if (pastNights.isEmpty()) {
        item {
          Text(
            historyError?.let { "Couldn't load history: $it" }
              ?: "No prior reflections yet — this list grows as you save.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      } else {
        items_for_history(pastNights)
      }
    }
  }
}

private fun androidx.compose.foundation.lazy.LazyListScope.items_for_history(
  rows: List<ReflectionRow>,
) {
  rows.forEach { row ->
    item(key = "history-${row.dateKey}") {
      ReflectionHistoryCard(row)
    }
  }
}

@Composable
private fun ReflectionHistoryCard(row: ReflectionRow) {
  var expanded by rememberSaveable(row.dateKey) { mutableStateOf(false) }
  val hasBody =
    !row.wentWell.isNullOrBlank() ||
      !row.didntGo.isNullOrBlank() ||
      !row.tomorrowOneThing.isNullOrBlank()
  Card(
    modifier = Modifier
      .fillMaxWidth()
      .clickable(enabled = hasBody) { expanded = !expanded }
      .animateContentSize(),
    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
  ) {
    Column(modifier = Modifier.padding(12.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        EnergyDot(row.energyLevel)
        Spacer(modifier = Modifier.size(12.dp))
        Column(modifier = Modifier.weight(1f)) {
          Text(
            text = formatHistoryDate(row.dateKey),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
          )
          val previewText = row.wentWell?.takeIf { it.isNotBlank() }
            ?: row.tomorrowOneThing?.takeIf { it.isNotBlank() }
            ?: row.didntGo?.takeIf { it.isNotBlank() }
          if (!expanded && !previewText.isNullOrBlank()) {
            Text(
              text = previewText,
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
          }
        }
        if (hasBody) {
          Icon(
            imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
            contentDescription = if (expanded) "Collapse" else "Expand",
          )
        }
      }
      if (expanded) {
        Spacer(modifier = Modifier.size(8.dp))
        HistoryField("What went well", row.wentWell)
        HistoryField("What didn't go", row.didntGo)
        HistoryField("Tomorrow's one thing", row.tomorrowOneThing)
      }
    }
  }
}

@Composable
private fun HistoryField(label: String, value: String?) {
  if (value.isNullOrBlank()) return
  Column(modifier = Modifier.padding(top = 6.dp)) {
    Text(
      text = label,
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      fontWeight = FontWeight.Medium,
    )
    Text(text = value, style = MaterialTheme.typography.bodyMedium)
  }
}

@Composable
private fun EnergyDot(level: Int?) {
  val color = if (level != null) energyColor(level) else MaterialTheme.colorScheme.surfaceVariant
  Box(
    modifier = Modifier
      .size(28.dp)
      .clip(CircleShape)
      .background(color),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = level?.toString() ?: "—",
      style = MaterialTheme.typography.labelMedium,
      color = Color.White,
      fontWeight = FontWeight.Bold,
    )
  }
}

private fun formatHistoryDate(dateKey: String): String {
  return try {
    val d = LocalDate.parse(dateKey)
    val formatter = DateTimeFormatter.ofPattern("EEE · MMM d", Locale.getDefault())
    d.format(formatter)
  } catch (_: Throwable) {
    dateKey
  }
}

private data class ReflectionRow(
  val dateKey: String,
  val energyLevel: Int?,
  val wentWell: String?,
  val didntGo: String?,
  val tomorrowOneThing: String?,
)

private fun energyColor(level: Int): Color {
  return when {
    level >= 8 -> Color(0xFF1B5E20) // green
    level >= 5 -> Color(0xFFFFAB00) // amber
    else -> Color(0xFFFF5A47) // red
  }
}
