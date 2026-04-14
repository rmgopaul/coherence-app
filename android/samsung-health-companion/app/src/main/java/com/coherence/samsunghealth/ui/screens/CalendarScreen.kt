package com.coherence.samsunghealth.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.ui.state.dataOrNull
import com.coherence.samsunghealth.ui.state.errorOrNull
import com.coherence.samsunghealth.ui.state.isLoading
import com.coherence.samsunghealth.ui.state.updatedAtOrNull
import com.coherence.samsunghealth.ui.widgets.CalendarWidget

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarScreen(viewModel: DashboardViewModel) {
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
          text = "Calendar",
          style = MaterialTheme.typography.headlineMedium,
          modifier = Modifier.padding(bottom = 4.dp),
        )
      }
      item {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          listOf(7, 30, 90).forEach { windowDays ->
            FilterChip(
              selected = state.eventWindowDays == windowDays,
              onClick = { viewModel.setEventWindowDays(windowDays) },
              label = { Text("$windowDays days") },
            )
          }
        }
      }
      item {
        CalendarWidget(
          events = state.eventsState.dataOrNull().orEmpty(),
          isLoading = state.eventsState.isLoading(),
          error = state.eventsState.errorOrNull(),
          lastUpdatedMillis = state.eventsState.updatedAtOrNull(),
          onRetry = { viewModel.retryEvents() },
          maxItems = 30,
        )
      }
    }
  }
}
