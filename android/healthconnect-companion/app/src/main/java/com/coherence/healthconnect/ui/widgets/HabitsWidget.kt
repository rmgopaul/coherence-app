package com.coherence.healthconnect.ui.widgets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.TrackChanges
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.HabitWithCompletion
import com.coherence.healthconnect.data.repository.HabitsRepository
import kotlinx.coroutines.launch

private fun habitColor(color: String): Color = when (color) {
  "red" -> Color(0xFFEF4444); "green" -> Color(0xFF22C55E); "blue" -> Color(0xFF3B82F6)
  "purple" -> Color(0xFFA855F7); "orange" -> Color(0xFFF97316); "pink" -> Color(0xFFEC4899)
  "teal" -> Color(0xFF14B8A6); "indigo" -> Color(0xFF6366F1)
  else -> Color(0xFF64748B)
}

@Composable
fun HabitsWidget(habitsRepo: HabitsRepository) {
  val habits = remember { mutableStateListOf<HabitWithCompletion>() }
  val scope = rememberCoroutineScope()

  LaunchedEffect(Unit) {
    try { habits.addAll(habitsRepo.getForDate()) } catch (_: Exception) {}
  }

  WidgetShell(title = "Habits", icon = Icons.Default.TrackChanges, category = WidgetCategory.HEALTH) {
    if (habits.isEmpty()) {
      Text("No habits defined", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    } else {
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        habits.filter { it.isActive }.forEach { habit ->
          Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(habitColor(habit.color)))
            Spacer(Modifier.width(10.dp))
            Text(habit.name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            IconButton(
              onClick = {
                val idx = habits.indexOfFirst { it.id == habit.id }
                if (idx >= 0) {
                  val newCompleted = !habits[idx].completed
                  habits[idx] = habits[idx].copy(completed = newCompleted)
                  scope.launch { habitsRepo.setCompletion(habit.id, newCompleted) }
                }
              },
              modifier = Modifier.size(28.dp),
            ) {
              Icon(
                if (habit.completed) Icons.Default.CheckCircle else Icons.Default.RadioButtonUnchecked,
                contentDescription = null,
                tint = if (habit.completed) habitColor(habit.color) else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
              )
            }
          }
        }
      }
    }
  }
}
