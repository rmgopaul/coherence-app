package com.coherence.healthconnect.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.PauseCircle
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.ClockifyTimeEntry
import com.coherence.healthconnect.ui.LocalApp
import kotlinx.coroutines.launch

private fun formatDuration(seconds: Long?): String {
  if (seconds == null || seconds < 0) return "0:00:00"
  val h = seconds / 3600
  val m = (seconds % 3600) / 60
  val s = seconds % 60
  return "$h:%02d:%02d".format(m, s)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClockifyScreen(onBack: () -> Unit) {
  val app = LocalApp.current
  val repo = app.container.clockifyRepository
  val scope = rememberCoroutineScope()

  var currentEntry by remember { mutableStateOf<ClockifyTimeEntry?>(null) }
  val recentEntries = remember { mutableStateListOf<ClockifyTimeEntry>() }
  var isLoading by remember { mutableStateOf(true) }
  var newTimerDesc by remember { mutableStateOf("") }

  fun reload() {
    scope.launch {
      try {
        currentEntry = repo.getCurrentEntry()
        recentEntries.clear()
        recentEntries.addAll(repo.getRecentEntries(20))
      } catch (_: Exception) {}
      isLoading = false
    }
  }

  LaunchedEffect(Unit) { reload() }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Clockify") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
          }
        },
      )
    },
  ) { padding ->
    if (isLoading) {
      Column(
        modifier = Modifier.fillMaxSize().padding(padding),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
      ) { CircularProgressIndicator() }
    } else {
      LazyColumn(
        modifier = Modifier.padding(padding),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        // Current timer section
        item {
          Card(
            colors = CardDefaults.cardColors(
              containerColor = if (currentEntry?.isRunning == true)
                MaterialTheme.colorScheme.primaryContainer
              else MaterialTheme.colorScheme.surface,
            ),
            elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
          ) {
            Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
              Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                  Icons.Default.Timer,
                  contentDescription = null,
                  modifier = Modifier.size(24.dp),
                  tint = if (currentEntry?.isRunning == true)
                    MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.width(8.dp))
                Text("Current Timer", style = MaterialTheme.typography.titleMedium)
              }
              Spacer(Modifier.height(12.dp))

              if (currentEntry?.isRunning == true) {
                Text(
                  currentEntry?.description?.ifBlank { "(no description)" } ?: "(no description)",
                  style = MaterialTheme.typography.bodyLarge,
                  fontWeight = FontWeight.Medium,
                )
                currentEntry?.projectName?.let { project ->
                  Text(project, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                }
                Spacer(Modifier.height(8.dp))
                Text(
                  formatDuration(currentEntry?.durationSeconds),
                  style = MaterialTheme.typography.headlineSmall,
                  fontWeight = FontWeight.Bold,
                  color = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.height(12.dp))
                Button(
                  onClick = {
                    scope.launch {
                      repo.stopTimer()
                      reload()
                    }
                  },
                  colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFEF4444)),
                ) {
                  Icon(Icons.Default.PauseCircle, contentDescription = null, modifier = Modifier.size(20.dp))
                  Spacer(Modifier.width(8.dp))
                  Text("Stop Timer")
                }
              } else {
                Text("No timer running", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                  value = newTimerDesc,
                  onValueChange = { newTimerDesc = it },
                  placeholder = { Text("What are you working on?") },
                  modifier = Modifier.fillMaxWidth(),
                  singleLine = true,
                )
                Spacer(Modifier.height(8.dp))
                Button(
                  onClick = {
                    if (newTimerDesc.isNotBlank()) {
                      scope.launch {
                        repo.startTimer(newTimerDesc)
                        newTimerDesc = ""
                        reload()
                      }
                    }
                  },
                  enabled = newTimerDesc.isNotBlank(),
                ) {
                  Icon(Icons.Default.PlayCircle, contentDescription = null, modifier = Modifier.size(20.dp))
                  Spacer(Modifier.width(8.dp))
                  Text("Start Timer")
                }
              }
            }
          }
        }

        // Recent entries
        item {
          Text(
            "Recent Entries",
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(top = 16.dp, bottom = 4.dp),
          )
        }

        if (recentEntries.isEmpty()) {
          item {
            Text("No recent entries", color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        } else {
          items(recentEntries.filter { !it.isRunning }) { entry ->
            TimeEntryRow(entry)
          }
        }
      }
    }
  }
}

@Composable
private fun TimeEntryRow(entry: ClockifyTimeEntry) {
  Card(
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Column(modifier = Modifier.weight(1f)) {
        Text(
          entry.description.ifBlank { "(no description)" },
          style = MaterialTheme.typography.bodyMedium,
          fontWeight = FontWeight.Medium,
        )
        Row {
          entry.projectName?.let { project ->
            Text(project, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(8.dp))
          }
          entry.start?.let { start ->
            Text(start.substring(11, 16), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
      }
      Text(
        formatDuration(entry.durationSeconds),
        style = MaterialTheme.typography.labelLarge,
        fontWeight = FontWeight.Medium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}
