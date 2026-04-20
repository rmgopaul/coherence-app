package com.coherence.healthconnect.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.LocalFireDepartment
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.HabitStreak
import com.coherence.healthconnect.data.model.HabitWithCompletion
import com.coherence.healthconnect.ui.LocalApp
import kotlinx.coroutines.launch

private fun habitColor(color: String): Color = when (color) {
  "red" -> Color(0xFFEF4444)
  "orange" -> Color(0xFFF97316)
  "amber" -> Color(0xFFF59E0B)
  "yellow" -> Color(0xFFEAB308)
  "lime" -> Color(0xFF84CC16)
  "green" -> Color(0xFF22C55E)
  "emerald" -> Color(0xFF10B981)
  "teal" -> Color(0xFF14B8A6)
  "cyan" -> Color(0xFF06B6D4)
  "sky" -> Color(0xFF0EA5E9)
  "blue" -> Color(0xFF3B82F6)
  "indigo" -> Color(0xFF6366F1)
  "violet" -> Color(0xFF8B5CF6)
  "purple" -> Color(0xFFA855F7)
  "fuchsia" -> Color(0xFFD946EF)
  "pink" -> Color(0xFFEC4899)
  "rose" -> Color(0xFFF43F5E)
  else -> Color(0xFF64748B) // slate
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HabitsScreen(onBack: () -> Unit) {
  val app = LocalApp.current
  val repo = app.container.habitsRepository
  val scope = rememberCoroutineScope()

  val habits = remember { mutableStateListOf<HabitWithCompletion>() }
  val streaks = remember { mutableStateListOf<HabitStreak>() }
  var isLoading by remember { mutableStateOf(true) }

  LaunchedEffect(Unit) {
    habits.addAll(repo.getForDate())
    streaks.addAll(repo.getStreaks())
    isLoading = false
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Habits") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
          }
        },
      )
    },
  ) { padding ->
    LazyColumn(
      modifier = Modifier.padding(padding),
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      item {
        Text("Today", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 4.dp))
      }

      items(habits.filter { it.isActive }) { habit ->
        val streak = streaks.firstOrNull { it.habitId == habit.id }
        HabitRow(
          habit = habit,
          streak = streak?.streak ?: 0,
          onToggle = {
            val newCompleted = !habit.completed
            val idx = habits.indexOfFirst { it.id == habit.id }
            if (idx >= 0) habits[idx] = habits[idx].copy(completed = newCompleted)
            scope.launch { repo.setCompletion(habit.id, newCompleted) }
          },
        )
      }

      if (habits.isEmpty() && !isLoading) {
        item {
          Text("No habits defined yet. Add them from the web dashboard.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
      }
    }
  }
}

@Composable
private fun HabitRow(
  habit: HabitWithCompletion,
  streak: Int,
  onToggle: () -> Unit,
) {
  val color = habitColor(habit.color)

  Card(
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Box(
        modifier = Modifier.size(12.dp).clip(CircleShape).background(color),
      )
      Spacer(modifier = Modifier.width(12.dp))
      Text(
        habit.name,
        style = MaterialTheme.typography.bodyLarge,
        modifier = Modifier.weight(1f),
        fontWeight = if (!habit.completed) FontWeight.Medium else FontWeight.Normal,
        color = if (habit.completed) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
      )
      if (streak > 0) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Icon(Icons.Default.LocalFireDepartment, contentDescription = null, modifier = Modifier.size(16.dp), tint = Color(0xFFFF6D00))
          Text("$streak", style = MaterialTheme.typography.labelMedium, color = Color(0xFFFF6D00))
        }
        Spacer(modifier = Modifier.width(8.dp))
      }
      IconButton(onClick = onToggle, modifier = Modifier.size(32.dp)) {
        Icon(
          if (habit.completed) Icons.Default.CheckCircle else Icons.Default.RadioButtonUnchecked,
          contentDescription = if (habit.completed) "Completed" else "Mark complete",
          tint = if (habit.completed) color else MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.size(24.dp),
        )
      }
    }
  }
}
