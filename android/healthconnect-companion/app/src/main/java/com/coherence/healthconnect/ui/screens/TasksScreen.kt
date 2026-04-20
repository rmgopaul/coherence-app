package com.coherence.healthconnect.ui.screens

import android.app.DatePickerDialog
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.FloatingActionButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.TodoistProject
import com.coherence.healthconnect.ui.state.dataOrNull
import com.coherence.healthconnect.ui.state.errorOrNull
import com.coherence.healthconnect.ui.state.isLoading
import com.coherence.healthconnect.ui.state.updatedAtOrNull
import com.coherence.healthconnect.ui.widgets.TodoistWidget
import java.time.LocalDate

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(viewModel: DashboardViewModel) {
  val state by viewModel.state.collectAsState()
  var showCreateDialog by rememberSaveable { mutableStateOf(false) }
  val projects = state.projectsState.dataOrNull().orEmpty()

  Scaffold(
    floatingActionButton = {
      FloatingActionButton(
        onClick = { showCreateDialog = true },
        elevation = FloatingActionButtonDefaults.elevation(defaultElevation = 2.dp),
      ) {
        Icon(Icons.Default.Add, contentDescription = "Create task")
      }
    },
  ) { innerPadding ->
    PullToRefreshBox(
      isRefreshing = state.isRefreshing,
      onRefresh = { viewModel.refresh() },
      modifier = Modifier
        .fillMaxSize()
        .padding(innerPadding),
    ) {
      LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        item {
          Text(
            text = "Tasks",
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.padding(bottom = 4.dp),
          )
        }
        item {
          TodoistWidget(
            tasks = state.tasksState.dataOrNull().orEmpty(),
            isLoading = state.tasksState.isLoading(),
            onComplete = { viewModel.completeTask(it) },
            error = state.tasksState.errorOrNull(),
            lastUpdatedMillis = state.tasksState.updatedAtOrNull(),
            onRetry = { viewModel.retryTasks() },
            maxItems = 50,
          )
        }
      }
    }
  }

  if (showCreateDialog) {
    CreateTaskDialog(
      projects = projects,
      onDismiss = { showCreateDialog = false },
      onCreate = { title, description, projectId, priority, dueDate, onError ->
        viewModel.createTask(
          content = title,
          description = description,
          projectId = projectId,
          priority = priority,
          dueDate = dueDate,
          onError = onError,
          onSuccess = { showCreateDialog = false },
        )
      },
    )
  }
}

@Composable
private fun CreateTaskDialog(
  projects: List<TodoistProject>,
  onDismiss: () -> Unit,
  onCreate: (
    title: String,
    description: String?,
    projectId: String?,
    priority: Int?,
    dueDate: String?,
    onError: (String) -> Unit,
  ) -> Unit,
) {
  val context = LocalContext.current
  var title by rememberSaveable { mutableStateOf("") }
  var description by rememberSaveable { mutableStateOf("") }
  var selectedProjectId by rememberSaveable { mutableStateOf<String?>(null) }
  var projectMenuExpanded by remember { mutableStateOf(false) }
  var selectedPriority by rememberSaveable { mutableStateOf(1) }
  var dueDate by rememberSaveable { mutableStateOf<String?>(null) }
  var formError by rememberSaveable { mutableStateOf<String?>(null) }

  val selectedProjectName = projects.firstOrNull { it.id == selectedProjectId }?.name ?: "No project"

  fun openDatePicker() {
    val today = LocalDate.now()
    val picker = DatePickerDialog(
      context,
      { _, year, month, dayOfMonth ->
        dueDate = "%04d-%02d-%02d".format(year, month + 1, dayOfMonth)
      },
      today.year,
      today.monthValue - 1,
      today.dayOfMonth,
    )
    picker.show()
  }

  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text("Create Task") },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
          value = title,
          onValueChange = {
            title = it
            formError = null
          },
          label = { Text("Title") },
          singleLine = true,
          modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
          value = description,
          onValueChange = { description = it },
          label = { Text("Description (optional)") },
          modifier = Modifier.fillMaxWidth(),
          minLines = 2,
          maxLines = 3,
        )
        Column {
          Text("Project", style = MaterialTheme.typography.labelMedium)
          Button(
            onClick = { projectMenuExpanded = true },
            modifier = Modifier.fillMaxWidth(),
          ) {
            Text(selectedProjectName)
          }
          DropdownMenu(
            expanded = projectMenuExpanded,
            onDismissRequest = { projectMenuExpanded = false },
          ) {
            DropdownMenuItem(
              text = { Text("No project") },
              onClick = {
                selectedProjectId = null
                projectMenuExpanded = false
              },
            )
            projects.forEach { project ->
              DropdownMenuItem(
                text = { Text(project.name) },
                onClick = {
                  selectedProjectId = project.id
                  projectMenuExpanded = false
                },
              )
            }
          }
        }
        Column {
          Text("Priority", style = MaterialTheme.typography.labelMedium)
          DropdownMenuButton(
            options = listOf(
              4 to "P1 - Urgent",
              3 to "P2 - High",
              2 to "P3 - Medium",
              1 to "P4 - Low",
            ),
            selected = selectedPriority,
            onSelected = { selectedPriority = it },
          )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
          Button(onClick = { openDatePicker() }) {
            Icon(Icons.Default.CalendarMonth, contentDescription = null)
            Text("Pick due date", modifier = Modifier.padding(start = 6.dp))
          }
          if (dueDate != null) {
            TextButton(onClick = { dueDate = null }) {
              Text("Clear ($dueDate)")
            }
          }
        }
        if (formError != null) {
          Text(
            text = formError ?: "",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
          )
        }
      }
    },
    confirmButton = {
      Button(onClick = {
        onCreate(
          title,
          description.takeIf { it.isNotBlank() },
          selectedProjectId,
          selectedPriority,
          dueDate,
        ) { message ->
          formError = message
        }
      }) {
        Text("Create")
      }
    },
    dismissButton = {
      TextButton(onClick = onDismiss) {
        Text("Cancel")
      }
    },
  )
}

@Composable
private fun DropdownMenuButton(
  options: List<Pair<Int, String>>,
  selected: Int,
  onSelected: (Int) -> Unit,
) {
  var expanded by remember { mutableStateOf(false) }
  val selectedLabel = options.firstOrNull { it.first == selected }?.second ?: "Select"

  Button(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
    Text(selectedLabel)
  }
  DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
    options.forEach { (value, label) ->
      DropdownMenuItem(
        text = { Text(label) },
        onClick = {
          onSelected(value)
          expanded = false
        },
      )
    }
  }
}
