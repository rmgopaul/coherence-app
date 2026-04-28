package com.coherence.healthconnect.ui.widgets

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircleOutline
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.TodoistTask
import java.time.LocalDate
import java.time.format.DateTimeFormatter

private fun priorityColor(priority: Int): Color = when (priority) {
  4 -> Color(0xFFD1453B) // p1 red
  3 -> Color(0xFFEB8909) // p2 orange
  2 -> Color(0xFF246FE0) // p3 blue
  else -> Color.Gray     // p4 no priority
}

private enum class TaskFilter(val label: String) {
  TODAY("Today"),
  UPCOMING("Upcoming"),
  ALL("All"),
}

@Composable
fun TodoistWidget(
  tasks: List<TodoistTask>,
  isLoading: Boolean,
  onComplete: (String) -> Unit,
  error: String? = null,
  lastUpdatedMillis: Long? = null,
  onRetry: (() -> Unit)? = null,
  maxItems: Int = 8,
) {
  var filter by remember { mutableStateOf(TaskFilter.TODAY) }
  val today = remember { LocalDate.now().format(DateTimeFormatter.ISO_LOCAL_DATE) }

  val filteredTasks = remember(tasks, filter) {
    when (filter) {
      TaskFilter.TODAY -> tasks.filter { task ->
        val dueDate = task.due?.date
        dueDate != null && dueDate <= today
      }
      TaskFilter.UPCOMING -> tasks.filter { task ->
        task.due?.date != null
      }.sortedBy { it.due?.date }
      TaskFilter.ALL -> tasks
    }
  }

  WidgetShell(
    title = "Tasks",
    icon = Icons.Default.CheckCircleOutline,
    category = WidgetCategory.PRODUCTIVITY,
    isLoading = isLoading && tasks.isEmpty(),
    error = if (tasks.isEmpty()) error else null,
    onRetry = if (tasks.isEmpty()) onRetry else null,
    lastUpdated = lastUpdatedMillis,
  ) {
    // Filter chips
    Row(
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      modifier = Modifier.padding(bottom = 8.dp),
    ) {
      TaskFilter.entries.forEach { f ->
        FilterChip(
          selected = filter == f,
          onClick = { filter = f },
          label = {
            val count = when (f) {
              TaskFilter.TODAY -> tasks.count { it.due?.date != null && it.due.date <= today }
              TaskFilter.UPCOMING -> tasks.count { it.due?.date != null }
              TaskFilter.ALL -> tasks.size
            }
            Text("${f.label} ($count)")
          },
        )
      }
    }

    if (isLoading && tasks.isEmpty()) {
      Text(
        "Loading tasks...",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else if (filteredTasks.isEmpty()) {
      Text(
        if (filter == TaskFilter.TODAY) "Today's list is clear. Pick the next thing that matters."
        else "No tasks here. Capture one when it shows up.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else {
      Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        filteredTasks.take(maxItems).forEach { task ->
          TodoistTaskRow(task = task, onComplete = onComplete, showDue = filter != TaskFilter.TODAY)
        }
        if (filteredTasks.size > maxItems) {
          Text(
            "+${filteredTasks.size - maxItems} more",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 40.dp, top = 4.dp),
          )
        }
      }
    }
  }
}

@Composable
private fun TodoistTaskRow(
  task: TodoistTask,
  onComplete: (String) -> Unit,
  showDue: Boolean = true,
) {
  var completed by remember { mutableStateOf(false) }
  val textColor by animateColorAsState(
    if (completed) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
    else MaterialTheme.colorScheme.onSurface,
    label = "taskTextColor",
  )

  Row(
    modifier = Modifier
      .fillMaxWidth()
      .padding(vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    IconButton(
      onClick = {
        if (!completed) {
          completed = true
          onComplete(task.id)
        }
      },
      modifier = Modifier.size(32.dp),
    ) {
      Icon(
        imageVector = if (completed) Icons.Default.CheckCircleOutline else Icons.Default.RadioButtonUnchecked,
        contentDescription = "Complete task",
        tint = if (completed) MaterialTheme.colorScheme.primary else priorityColor(task.priority),
        modifier = Modifier.size(20.dp),
      )
    }

    Spacer(modifier = Modifier.width(8.dp))

    Column(modifier = Modifier.weight(1f)) {
      Text(
        text = task.content,
        style = MaterialTheme.typography.bodyMedium,
        color = textColor,
        textDecoration = if (completed) TextDecoration.LineThrough else null,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
      )
      if (showDue && task.due != null) {
        Text(
          text = task.due.string.ifBlank { task.due.date },
          style = MaterialTheme.typography.labelSmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }

    if (task.priority > 1) {
      Icon(
        Icons.Default.Flag,
        contentDescription = "Priority ${5 - task.priority}",
        tint = priorityColor(task.priority),
        modifier = Modifier.size(16.dp),
      )
    }
  }
}
