package com.coherence.healthconnect.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.ui.LocalApp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

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

  // Pre-populate from server on entry. If the user already saved
  // a reflection today, we want to edit it, not overwrite.
  LaunchedEffect(Unit) {
    try {
      val response = app.container.trpcClient.query("reflections.getToday")
      val obj = response as? JsonObject ?: return@LaunchedEffect
      val reflection = obj["reflection"] as? JsonObject ?: return@LaunchedEffect
      reflection["energyLevel"]?.jsonPrimitive?.intOrNull?.let { energyLevel = it.toFloat() }
      (reflection["wentWell"] as? JsonPrimitive)?.contentOrNull?.let { wentWell = it }
      (reflection["didntGo"] as? JsonPrimitive)?.contentOrNull?.let { didntGo = it }
      (reflection["tomorrowOneThing"] as? JsonPrimitive)?.contentOrNull?.let { tomorrowOneThing = it }
    } catch (e: Throwable) {
      loadError = e.message
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
      modifier = Modifier.fillMaxSize(),
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
    }
  }
}

private fun energyColor(level: Int): androidx.compose.ui.graphics.Color {
  return when {
    level >= 8 -> androidx.compose.ui.graphics.Color(0xFF1B5E20) // green
    level >= 5 -> androidx.compose.ui.graphics.Color(0xFFFFAB00) // amber
    else -> androidx.compose.ui.graphics.Color(0xFFFF5A47) // red
  }
}
