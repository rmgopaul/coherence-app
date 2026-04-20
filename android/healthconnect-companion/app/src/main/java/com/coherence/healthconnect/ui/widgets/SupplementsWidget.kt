package com.coherence.healthconnect.ui.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Medication
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.SupplementDefinition
import com.coherence.healthconnect.data.model.SupplementLog
import com.coherence.healthconnect.data.repository.SupplementsRepository
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import androidx.compose.foundation.layout.size

@Composable
fun SupplementsWidget(supplementsRepo: SupplementsRepository) {
  val definitions = remember { mutableStateListOf<SupplementDefinition>() }
  val todayLogs = remember { mutableStateListOf<SupplementLog>() }
  val scope = rememberCoroutineScope()
  val today = LocalDate.now().format(DateTimeFormatter.ISO_LOCAL_DATE)

  LaunchedEffect(Unit) {
    try {
      definitions.addAll(supplementsRepo.listDefinitions())
      todayLogs.addAll(supplementsRepo.getLogs(today))
    } catch (_: Exception) {}
  }

  WidgetShell(title = "Supplements", icon = Icons.Default.Medication, category = WidgetCategory.HEALTH) {
    if (definitions.isEmpty()) {
      Text("No supplements defined", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    } else {
      val active = definitions.filter { it.isActive }
      val totalLogged = active.count { supp -> todayLogs.any { it.definitionId == supp.id || it.name == supp.name } }
      Text(
        "$totalLogged / ${active.size} taken today",
        style = MaterialTheme.typography.bodyMedium,
        color = if (totalLogged == active.size) Color(0xFF00C853) else MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        active.take(6).forEach { supp ->
          val isLogged = todayLogs.any { it.definitionId == supp.id || it.name == supp.name }
          Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Icon(
              if (isLogged) Icons.Default.CheckCircle else Icons.Default.RadioButtonUnchecked,
              contentDescription = null,
              tint = if (isLogged) Color(0xFF00C853) else MaterialTheme.colorScheme.onSurfaceVariant,
              modifier = Modifier.size(16.dp),
            )
            Text(
              " ${supp.name}",
              style = MaterialTheme.typography.bodySmall,
              color = if (isLogged) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            )
          }
        }
        if (active.size > 6) {
          Text("+${active.size - 6} more", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
      }
    }
  }
}
