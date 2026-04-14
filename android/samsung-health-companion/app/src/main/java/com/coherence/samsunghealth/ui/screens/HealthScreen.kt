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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.sdk.HealthConnectStatus
import com.coherence.samsunghealth.sync.AutoSyncScheduler
import com.coherence.samsunghealth.ui.health.HealthConnectPermissionHost
import com.coherence.samsunghealth.ui.state.dataOrNull
import com.coherence.samsunghealth.ui.state.errorOrNull
import com.coherence.samsunghealth.ui.state.isLoading
import com.coherence.samsunghealth.ui.state.updatedAtOrNull
import com.coherence.samsunghealth.ui.widgets.HealthWidget
import com.coherence.samsunghealth.ui.widgets.WhoopWidget

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HealthScreen(viewModel: DashboardViewModel) {
  val state by viewModel.state.collectAsState()
  val context = LocalContext.current
  var hcStatus by remember { mutableStateOf<HealthConnectStatus?>(null) }

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
        // First-run permission prompt. When permissions transition
        // from missing → granted, trigger an immediate sync so the
        // dashboard shows real data without waiting for the 15-min
        // periodic worker.
        HealthConnectPermissionHost(
          onStatusChanged = { next ->
            val wasIncomplete = hcStatus?.permissionsGranted == false
            hcStatus = next
            if (wasIncomplete && next.permissionsGranted) {
              AutoSyncScheduler.enable(context)
            }
          },
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
