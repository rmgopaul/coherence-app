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
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.ui.LocalApp
import com.coherence.samsunghealth.ui.state.dataOrNull
import com.coherence.samsunghealth.ui.state.errorOrNull
import com.coherence.samsunghealth.ui.state.isLoading
import com.coherence.samsunghealth.ui.state.updatedAtOrNull
import com.coherence.samsunghealth.ui.widgets.HealthWidget
import com.coherence.samsunghealth.ui.widgets.WhoopWidget

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HealthScreen() {
  val app = LocalApp.current
  val viewModel = app.dashboardViewModel
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
          text = "Health",
          style = MaterialTheme.typography.headlineMedium,
          modifier = Modifier.padding(bottom = 4.dp),
        )
      }
      item {
        HealthWidget(
          healthData = state.healthState.dataOrNull(),
          isLoading = state.healthState.isLoading(),
          error = state.healthState.errorOrNull(),
          lastUpdatedMillis = state.healthState.updatedAtOrNull(),
          onRetry = { viewModel.retryHealth() },
        )
      }
      item {
        WhoopWidget(
          summary = state.whoopState.dataOrNull(),
          isLoading = state.whoopState.isLoading(),
          error = state.whoopState.errorOrNull(),
          lastUpdatedMillis = state.whoopState.updatedAtOrNull(),
          onRetry = { viewModel.retryWhoop() },
        )
      }
    }
  }
}
