package com.coherence.samsunghealth.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Medication
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.data.model.SupplementDefinition
import com.coherence.samsunghealth.data.model.SupplementLog
import com.coherence.samsunghealth.ui.LocalApp
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SupplementsScreen(onBack: () -> Unit) {
  val app = LocalApp.current
  val repo = app.container.supplementsRepository
  val scope = rememberCoroutineScope()

  val definitions = remember { mutableStateListOf<SupplementDefinition>() }
  val todayLogs = remember { mutableStateListOf<SupplementLog>() }
  var isLoading by remember { mutableStateOf(true) }

  val today = LocalDate.now().format(DateTimeFormatter.ISO_LOCAL_DATE)

  LaunchedEffect(Unit) {
    definitions.addAll(repo.listDefinitions())
    todayLogs.addAll(repo.getLogs(today))
    isLoading = false
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Supplements") },
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
      ) { Text("Loading supplements...") }
    } else {
      LazyColumn(
        modifier = Modifier.padding(padding),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        // AM supplements
        item {
          Text("Morning", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(vertical = 4.dp))
        }
        val amSupps = definitions.filter { it.timing == "am" && it.isActive }
        items(amSupps) { supp ->
          SupplementRow(
            definition = supp,
            isLogged = todayLogs.any { it.definitionId == supp.id || (it.name == supp.name && it.timing == "am") },
            onLog = {
              scope.launch {
                val success = repo.addLog(
                  name = supp.name, dose = supp.dose, doseUnit = supp.doseUnit,
                  timing = "am", dateKey = today, definitionId = supp.id,
                )
                if (success) {
                  todayLogs.add(SupplementLog(id = "local-${System.currentTimeMillis()}", definitionId = supp.id, name = supp.name, dose = supp.dose, doseUnit = supp.doseUnit, timing = "am", dateKey = today))
                }
              }
            },
          )
        }

        // PM supplements
        item {
          Text("Evening", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp, bottom = 4.dp))
        }
        val pmSupps = definitions.filter { it.timing == "pm" && it.isActive }
        items(pmSupps) { supp ->
          SupplementRow(
            definition = supp,
            isLogged = todayLogs.any { it.definitionId == supp.id || (it.name == supp.name && it.timing == "pm") },
            onLog = {
              scope.launch {
                val success = repo.addLog(
                  name = supp.name, dose = supp.dose, doseUnit = supp.doseUnit,
                  timing = "pm", dateKey = today, definitionId = supp.id,
                )
                if (success) {
                  todayLogs.add(SupplementLog(id = "local-${System.currentTimeMillis()}", definitionId = supp.id, name = supp.name, dose = supp.dose, doseUnit = supp.doseUnit, timing = "pm", dateKey = today))
                }
              }
            },
          )
        }

        if (amSupps.isEmpty() && pmSupps.isEmpty()) {
          item {
            Text("No supplements defined yet. Add them from the web dashboard.", color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
      }
    }
  }
}

@Composable
private fun SupplementRow(
  definition: SupplementDefinition,
  isLogged: Boolean,
  onLog: () -> Unit,
) {
  Card(
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      IconButton(onClick = { if (!isLogged) onLog() }, modifier = Modifier.size(32.dp)) {
        Icon(
          if (isLogged) Icons.Default.CheckCircle else Icons.Default.RadioButtonUnchecked,
          contentDescription = if (isLogged) "Logged" else "Log",
          tint = if (isLogged) Color(0xFF00C853) else MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.size(24.dp),
        )
      }
      Spacer(modifier = Modifier.width(12.dp))
      Column(modifier = Modifier.weight(1f)) {
        Text(definition.name, style = MaterialTheme.typography.bodyLarge, fontWeight = if (!isLogged) FontWeight.Medium else FontWeight.Normal)
        Text("${definition.dose} ${definition.doseUnit}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      if (definition.brand != null) {
        Text(definition.brand, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
  }
}
