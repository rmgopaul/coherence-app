package com.coherence.samsunghealth.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.ui.LocalApp
import com.coherence.samsunghealth.ui.widgets.CalendarWidget
import com.coherence.samsunghealth.ui.widgets.DashboardHero
import com.coherence.samsunghealth.ui.widgets.FocusTimerWidget
import com.coherence.samsunghealth.ui.widgets.GmailWidget
import com.coherence.samsunghealth.ui.widgets.HealthWidget
import com.coherence.samsunghealth.ui.widgets.HeroStats
import com.coherence.samsunghealth.ui.widgets.TodaysPlanWidget
import com.coherence.samsunghealth.ui.widgets.HabitsWidget
import com.coherence.samsunghealth.ui.widgets.SupplementsWidget
import com.coherence.samsunghealth.ui.widgets.TodoistWidget
import com.coherence.samsunghealth.ui.widgets.WhoopWidget
import java.time.LocalDate
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen() {
  val app = LocalApp.current
  val viewModel = app.dashboardViewModel
  val state by viewModel.state.collectAsState()

  val today = remember { LocalDate.now().format(DateTimeFormatter.ISO_LOCAL_DATE) }
  val heroStats = remember(state.tasks, state.events, state.whoop) {
    HeroStats(
      tasksDueToday = state.tasks.count { it.due?.date != null && it.due.date <= today },
      eventsToday = state.events.size,
      recoveryPercent = state.whoop?.recoveryScore?.toInt(),
    )
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

      // Today's Plan (AI-generated)
      item {
        TodaysPlanWidget(
          overview = state.planOverview,
          isGenerating = state.planGenerating,
          error = state.planError,
          onGenerate = { viewModel.generatePlan() },
        )
      }

      // Samsung Health
      item {
        HealthWidget(
          healthData = state.health,
          isLoading = state.healthLoading,
        )
      }

      // WHOOP
      item {
        WhoopWidget(
          summary = state.whoop,
          isLoading = state.whoopLoading,
        )
      }

      // Focus Timer
      item {
        FocusTimerWidget()
      }

      // Tasks
      item {
        TodoistWidget(
          tasks = state.tasks,
          isLoading = state.tasksLoading,
          onComplete = { viewModel.completeTask(it) },
        )
      }

      // Calendar
      item {
        CalendarWidget(
          events = state.events,
          isLoading = state.eventsLoading,
        )
      }

      // Gmail
      item {
        GmailWidget(
          messages = state.emails,
          isLoading = state.emailsLoading,
          onMarkRead = { viewModel.markEmailRead(it) },
        )
      }

      // Habits
      item {
        HabitsWidget(habitsRepo = app.habitsRepository)
      }

      // Supplements
      item {
        SupplementsWidget(supplementsRepo = app.supplementsRepository)
      }
    }
  }
}
