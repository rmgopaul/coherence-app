package com.coherence.samsunghealth.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.data.model.AppPreferences
import com.coherence.samsunghealth.data.model.SearchResultItem
import com.coherence.samsunghealth.ui.LocalApp
import com.coherence.samsunghealth.ui.state.dataOrNull
import com.coherence.samsunghealth.ui.state.errorOrNull
import com.coherence.samsunghealth.ui.state.isLoading
import com.coherence.samsunghealth.ui.state.updatedAtOrNull
import com.coherence.samsunghealth.ui.widgets.CalendarWidget
import com.coherence.samsunghealth.ui.widgets.DashboardHero
import com.coherence.samsunghealth.ui.widgets.FocusTimerWidget
import com.coherence.samsunghealth.ui.widgets.GmailWidget
import com.coherence.samsunghealth.ui.widgets.HabitsWidget
import com.coherence.samsunghealth.ui.widgets.HealthWidget
import com.coherence.samsunghealth.ui.widgets.HeroStats
import com.coherence.samsunghealth.ui.widgets.MarketHeadlinesWidget
import com.coherence.samsunghealth.ui.widgets.SupplementsWidget
import com.coherence.samsunghealth.ui.widgets.SuggestedActionsWidget
import com.coherence.samsunghealth.ui.widgets.TodaysPlanWidget
import com.coherence.samsunghealth.ui.widgets.TodoistWidget
import com.coherence.samsunghealth.ui.widgets.WidgetCategory
import com.coherence.samsunghealth.ui.widgets.WidgetShell
import com.coherence.samsunghealth.ui.widgets.WhoopWidget
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen() {
  val app = LocalApp.current
  val viewModel = app.dashboardViewModel
  val state by viewModel.state.collectAsState()
  val preferences by app.appPreferencesRepository.preferences.collectAsState(initial = AppPreferences())
  val tasks = state.tasksState.dataOrNull().orEmpty()
  val events = state.eventsState.dataOrNull().orEmpty()
  val whoop = state.whoopState.dataOrNull()
  val emails = state.emailsState.dataOrNull().orEmpty()
  val marketData = state.marketState.dataOrNull()
  val health = state.healthState.dataOrNull()
  val hiddenWidgets = preferences.hiddenWidgets
  var searchQuery by rememberSaveable { mutableStateOf("") }
  val searchResults = remember { mutableStateListOf<SearchResultItem>() }
  var searchLoading by remember { mutableStateOf(false) }
  var searchError by remember { mutableStateOf<String?>(null) }

  val today = remember { LocalDate.now().format(DateTimeFormatter.ISO_LOCAL_DATE) }
  val heroStats = remember(tasks, events, whoop) {
    HeroStats(
      tasksDueToday = tasks.count { it.due?.date != null && it.due.date <= today },
      eventsToday = events.count { event ->
        val startDate = event.start?.dateTime?.take(10) ?: event.start?.date
        startDate != null && startDate == today
      },
      recoveryPercent = whoop?.recoveryScore?.toInt(),
    )
  }

  LaunchedEffect(searchQuery) {
    val normalized = searchQuery.trim()
    if (normalized.length < 2) {
      searchResults.clear()
      searchError = null
      searchLoading = false
      return@LaunchedEffect
    }
    delay(250)
    searchLoading = true
    try {
      val response = app.searchRepository.globalSearch(normalized, 20)
      searchResults.clear()
      searchResults.addAll(response.items)
      searchError = null
    } catch (error: Exception) {
      searchError = error.message ?: "Search failed."
    } finally {
      searchLoading = false
    }
  }

  LaunchedEffect(preferences.refreshIntervalMinutes) {
    val refreshEveryMs = (preferences.refreshIntervalMinutes.coerceAtLeast(1)) * 60_000L
    while (isActive) {
      delay(refreshEveryMs)
      viewModel.refresh()
    }
  }

  PullToRefreshBox(
    isRefreshing = state.isRefreshing,
    onRefresh = { viewModel.refresh() },
    modifier = Modifier.fillMaxSize(),
  ) {
    LazyColumn(
      modifier = Modifier.fillMaxSize(),
      contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      // Hero greeting card
      item {
        DashboardHero(stats = heroStats)
      }

      // Global search command bar
      item {
        GlobalSearchWidget(
          query = searchQuery,
          onQueryChange = { searchQuery = it },
          isLoading = searchLoading,
          error = searchError,
          results = searchResults,
        )
      }

      // Today's Plan (AI-generated)
      if (!hiddenWidgets.contains("suggested_actions")) {
        item {
          SuggestedActionsWidget(
            suggestions = state.suggestedActions,
            onGeneratePlan = { viewModel.generatePlan() },
          )
        }
      }

      // Today's Plan (AI-generated)
      if (!hiddenWidgets.contains("todays_plan")) {
        item {
          TodaysPlanWidget(
            overview = state.planOverview,
            isGenerating = state.planGenerating,
            error = state.planError,
            onGenerate = { viewModel.generatePlan() },
          )
        }
      }

      // Headlines & Markets
      if (!hiddenWidgets.contains("headlines")) {
        item {
          MarketHeadlinesWidget(
            marketData = marketData,
            isLoading = state.marketState.isLoading(),
            error = state.marketState.errorOrNull(),
            lastUpdatedMillis = state.marketState.updatedAtOrNull(),
            onRetry = { viewModel.retryMarket() },
          )
        }
      }

      // Samsung Health
      if (!hiddenWidgets.contains("health")) {
        item {
          HealthWidget(
            healthData = health,
            isLoading = state.healthState.isLoading(),
            error = state.healthState.errorOrNull(),
            lastUpdatedMillis = state.healthState.updatedAtOrNull(),
            onRetry = { viewModel.retryHealth() },
          )
        }
      }

      // WHOOP
      if (!hiddenWidgets.contains("whoop")) {
        item {
          WhoopWidget(
            summary = whoop,
            isLoading = state.whoopState.isLoading(),
            error = state.whoopState.errorOrNull(),
            lastUpdatedMillis = state.whoopState.updatedAtOrNull(),
            onRetry = { viewModel.retryWhoop() },
          )
        }
      }

      // Focus Timer
      if (!hiddenWidgets.contains("focus_timer")) {
        item {
          FocusTimerWidget(focusDurationMinutes = preferences.focusDurationMinutes)
        }
      }

      // Tasks
      if (!hiddenWidgets.contains("tasks")) {
        item {
          TodoistWidget(
            tasks = tasks,
            isLoading = state.tasksState.isLoading(),
            onComplete = { viewModel.completeTask(it) },
            error = state.tasksState.errorOrNull(),
            lastUpdatedMillis = state.tasksState.updatedAtOrNull(),
            onRetry = { viewModel.retryTasks() },
          )
        }
      }

      // Calendar
      if (!hiddenWidgets.contains("calendar")) {
        item {
          CalendarWidget(
            events = events,
            isLoading = state.eventsState.isLoading(),
            error = state.eventsState.errorOrNull(),
            lastUpdatedMillis = state.eventsState.updatedAtOrNull(),
            onRetry = { viewModel.retryEvents() },
          )
        }
      }

      // Gmail
      if (!hiddenWidgets.contains("gmail")) {
        item {
          GmailWidget(
            messages = emails,
            isLoading = state.emailsState.isLoading(),
            onMarkRead = { viewModel.markEmailRead(it) },
            error = state.emailsState.errorOrNull(),
            lastUpdatedMillis = state.emailsState.updatedAtOrNull(),
            onRetry = { viewModel.retryEmails() },
          )
        }
      }

      // Habits
      if (!hiddenWidgets.contains("habits")) {
        item {
          HabitsWidget(habitsRepo = app.habitsRepository)
        }
      }

      // Supplements
      if (!hiddenWidgets.contains("supplements")) {
        item {
          SupplementsWidget(supplementsRepo = app.supplementsRepository)
        }
      }
    }
  }
}

@Composable
private fun GlobalSearchWidget(
  query: String,
  onQueryChange: (String) -> Unit,
  isLoading: Boolean,
  error: String?,
  results: List<SearchResultItem>,
) {
  WidgetShell(
    title = "Global Search",
    icon = Icons.Default.Search,
    category = WidgetCategory.PRODUCTIVITY,
    isLoading = false,
    error = null,
  ) {
    OutlinedTextField(
      value = query,
      onValueChange = onQueryChange,
      modifier = Modifier.fillMaxWidth(),
      singleLine = true,
      label = { Text("Search tasks, notes, calendar, chat, and drive") },
      trailingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
    )

    when {
      query.trim().length < 2 -> {
        Text(
          text = "Type at least 2 characters to search.",
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.padding(top = 8.dp),
        )
      }

      isLoading -> {
        Row(
          modifier = Modifier
            .fillMaxWidth()
            .padding(top = 10.dp),
          horizontalArrangement = Arrangement.Center,
          verticalAlignment = Alignment.CenterVertically,
        ) {
          CircularProgressIndicator(modifier = Modifier.padding(2.dp))
          Text(
            text = "Searching...",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 10.dp),
          )
        }
      }

      error != null -> {
        Text(
          text = error,
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.error,
          modifier = Modifier.padding(top = 8.dp),
        )
      }

      results.isEmpty() -> {
        Text(
          text = "No matches found.",
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.padding(top = 8.dp),
        )
      }

      else -> {
        Column(
          modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          results.take(8).forEach { item ->
            Column(modifier = Modifier.fillMaxWidth()) {
              Text(
                text = "${item.type.replace('_', ' ').uppercase()} • ${item.title}",
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
              )
              if (!item.subtitle.isNullOrBlank()) {
                Text(
                  text = item.subtitle,
                  style = MaterialTheme.typography.bodySmall,
                  color = MaterialTheme.colorScheme.onSurfaceVariant,
                  maxLines = 1,
                  overflow = TextOverflow.Ellipsis,
                )
              }
            }
          }
        }
      }
    }
  }
}
