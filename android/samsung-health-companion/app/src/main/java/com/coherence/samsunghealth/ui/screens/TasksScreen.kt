package com.coherence.samsunghealth.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.ui.LocalApp
import com.coherence.samsunghealth.ui.widgets.TodoistWidget

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen() {
  val app = LocalApp.current
  val viewModel = remember {
    DashboardViewModel(
      todoistRepo = app.todoistRepository,
      googleRepo = app.googleRepository,
      whoopRepo = app.whoopRepository,
    )
  }
  val state by viewModel.state.collectAsState()

  PullToRefreshBox(
    isRefreshing = state.isRefreshing,
    onRefresh = { viewModel.refresh() },
    modifier = Modifier.fillMaxSize(),
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
          tasks = state.tasks,
          isLoading = state.tasksLoading,
          onComplete = { viewModel.completeTask(it) },
          maxItems = 50,
        )
      }
    }
  }
}
