package com.coherence.samsunghealth.ui.screens

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.coherence.samsunghealth.di.AppContainer
import com.coherence.samsunghealth.data.model.CalendarEvent
import com.coherence.samsunghealth.data.model.GmailMessage
import com.coherence.samsunghealth.data.model.MarketDashboardResponse
import com.coherence.samsunghealth.data.model.SamsungHealthDisplay
import com.coherence.samsunghealth.data.model.SportsResponse
import com.coherence.samsunghealth.data.model.SuggestionItem
import com.coherence.samsunghealth.data.model.TodoistProject
import com.coherence.samsunghealth.data.model.TodoistTask
import com.coherence.samsunghealth.data.model.WhoopSummary
import com.coherence.samsunghealth.data.repository.GoogleRepository
import com.coherence.samsunghealth.data.repository.MarketRepository
import com.coherence.samsunghealth.data.repository.MetricsRepository
import com.coherence.samsunghealth.data.repository.PlanRepository
import com.coherence.samsunghealth.data.repository.SportsRepository
import com.coherence.samsunghealth.data.repository.TodoistRepository
import com.coherence.samsunghealth.data.repository.WhoopRepository
import com.coherence.samsunghealth.ui.state.LoadState
import com.coherence.samsunghealth.ui.state.dataOrNull
import com.coherence.samsunghealth.ui.state.updatedAtOrNull
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter

data class DashboardState(
  val tasksState: LoadState<List<TodoistTask>> = LoadState.Loading,
  val projectsState: LoadState<List<TodoistProject>> = LoadState.Loading,
  val eventsState: LoadState<List<CalendarEvent>> = LoadState.Loading,
  val eventWindowDays: Int = 30,
  val emailsState: LoadState<List<GmailMessage>> = LoadState.Loading,
  val marketState: LoadState<MarketDashboardResponse> = LoadState.Loading,
  val sportsState: LoadState<SportsResponse> = LoadState.Loading,
  val whoopState: LoadState<WhoopSummary?> = LoadState.Loading,
  val healthState: LoadState<SamsungHealthDisplay?> = LoadState.Loading,
  val isRefreshing: Boolean = false,
  val planOverview: String? = null,
  val planGenerating: Boolean = false,
  val planError: String? = null,
  val suggestedActions: List<SuggestionItem> = emptyList(),
)

class DashboardViewModel(
  private val todoistRepo: TodoistRepository,
  private val googleRepo: GoogleRepository,
  private val whoopRepo: WhoopRepository,
  private val metricsRepo: MetricsRepository? = null,
  private val planRepo: PlanRepository? = null,
  private val marketRepo: MarketRepository? = null,
  private val sportsRepo: SportsRepository? = null,
) : ViewModel() {

  private val _state = MutableStateFlow(DashboardState())
  val state: StateFlow<DashboardState> = _state.asStateFlow()
  private var refreshPendingLoads: Int = 0

  init {
    loadAll()
  }

  fun loadAll() {
    loadTasks()
    loadProjects()
    loadEvents()
    loadEmails()
    loadMarketData()
    loadSports()
    loadWhoop()
    loadHealth()
  }

  fun refresh() {
    synchronized(this) {
      refreshPendingLoads = 8
    }
    _state.value = _state.value.copy(isRefreshing = true)
    loadAll()
  }

  fun retryTasks() = loadTasks()
  fun retryProjects() = loadProjects()
  fun retryEvents() = loadEvents(_state.value.eventWindowDays)
  fun retryEmails() = loadEmails()
  fun retryMarket() = loadMarketData()
  fun retrySports() = loadSports()
  fun retryWhoop() = loadWhoop()
  fun retryHealth() = loadHealth()

  fun setEventWindowDays(days: Int) {
    val safeDays = days.coerceIn(1, 365)
    if (_state.value.eventWindowDays == safeDays) return
    _state.value = _state.value.copy(eventWindowDays = safeDays)
    loadEvents(safeDays)
  }

  private fun completeRefreshLoad() {
    val shouldEndRefresh = synchronized(this) {
      if (refreshPendingLoads <= 0) return@synchronized false
      refreshPendingLoads -= 1
      refreshPendingLoads <= 0
    }
    if (shouldEndRefresh) {
      _state.value = _state.value.copy(isRefreshing = false)
    }
  }

  private fun recomputeSuggestedActions() {
    val current = _state.value
    val tasks = current.tasksState.dataOrNull().orEmpty()
    val events = current.eventsState.dataOrNull().orEmpty()
    val emails = current.emailsState.dataOrNull().orEmpty()
    val whoop = current.whoopState.dataOrNull()

    val todayKey = LocalDate.now().format(DateTimeFormatter.ISO_LOCAL_DATE)
    val dueToday = tasks.count { it.due?.date != null && it.due.date <= todayKey }
    val unreadEmails = emails.count { it.isUnread }
    val nextEventMinutes = events
      .mapNotNull { event -> parseEventStartMillis(event)?.let { (it - System.currentTimeMillis()) / 60_000L } }
      .filter { it >= 0 }
      .minOrNull()

    val suggestions = mutableListOf<SuggestionItem>()

    if (current.planOverview.isNullOrBlank()) {
      suggestions += SuggestionItem(
        id = "generate-plan",
        title = "Generate your AI daily plan",
        reason = "No plan has been generated yet today.",
        actionType = "generate_plan",
        score = 1.0,
      )
    }
    if (dueToday >= 6) {
      suggestions += SuggestionItem(
        id = "task-overload",
        title = "Reduce today to your top 3 tasks",
        reason = "$dueToday tasks are due today. Prioritize to avoid spillover.",
        actionType = "focus_tasks",
        score = 0.95,
      )
    }
    if (nextEventMinutes != null && nextEventMinutes in 0..90) {
      suggestions += SuggestionItem(
        id = "next-meeting",
        title = "Prep for your next meeting now",
        reason = "Your next event starts in ${nextEventMinutes} min.",
        actionType = "prepare_meeting",
        score = 0.9,
      )
    }
    if (whoop?.recoveryScore != null && whoop.recoveryScore < 45.0) {
      suggestions += SuggestionItem(
        id = "recovery-low",
        title = "Protect recovery with a lighter block",
        reason = "Recovery is ${whoop.recoveryScore.toInt()}% today.",
        actionType = "recovery_mode",
        score = 0.92,
      )
    }
    if (unreadEmails >= 8) {
      suggestions += SuggestionItem(
        id = "email-triage",
        title = "Do a 15-minute email triage",
        reason = "$unreadEmails important/unread emails are waiting.",
        actionType = "triage_email",
        score = 0.78,
      )
    }
    if (tasks.isEmpty()) {
      suggestions += SuggestionItem(
        id = "no-tasks",
        title = "Capture your top priorities",
        reason = "No Todoist tasks are currently loaded.",
        actionType = "create_task",
        score = 0.7,
      )
    }

    _state.value = _state.value.copy(suggestedActions = suggestions.distinctBy { it.id }.take(5))
  }

  private fun parseEventStartMillis(event: CalendarEvent): Long? {
    val startDateTime = event.start?.dateTime
    if (!startDateTime.isNullOrBlank()) {
      return runCatching { Instant.parse(startDateTime).toEpochMilli() }.getOrNull()
    }
    val startDate = event.start?.date
    if (!startDate.isNullOrBlank()) {
      return runCatching {
        LocalDate.parse(startDate).atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli()
      }.getOrNull()
    }
    return null
  }

  fun generatePlan() {
    if (_state.value.planGenerating) return
    viewModelScope.launch {
      _state.value = _state.value.copy(planGenerating = true, planError = null)
      try {
        val today = java.time.LocalDate.now().format(java.time.format.DateTimeFormatter.ISO_LOCAL_DATE)
        val currentState = _state.value
        val tasks = currentState.tasksState.dataOrNull().orEmpty()
        val events = currentState.eventsState.dataOrNull().orEmpty()
        val emails = currentState.emailsState.dataOrNull().orEmpty()
        Log.d("DashboardVM", "Generating plan for $today with ${tasks.size} tasks, ${events.size} events")
        val result = planRepo?.generateDailyOverview(
          date = today,
          taskSummaries = tasks.map { it.content },
          eventSummaries = events.mapNotNull { it.summary },
          emailSummaries = emails.mapNotNull { msg ->
            msg.payload?.headers?.firstOrNull { it.name.equals("Subject", ignoreCase = true) }?.value
          },
        )
        if (result != null) {
          _state.value = _state.value.copy(planOverview = result, planGenerating = false)
        } else {
          _state.value = _state.value.copy(planGenerating = false, planError = "Failed to generate plan. Try again.")
        }
        recomputeSuggestedActions()
      } catch (e: Exception) {
        Log.e("DashboardVM", "Plan generation failed", e)
        _state.value = _state.value.copy(planGenerating = false, planError = "Error: ${e.message?.take(100)}")
        recomputeSuggestedActions()
      }
    }
  }

  private fun loadTasks() {
    val previous = _state.value.tasksState.dataOrNull()
    if (previous == null) {
      _state.value = _state.value.copy(tasksState = LoadState.Loading)
    }
    viewModelScope.launch {
      try {
        val tasks = todoistRepo.getTasks()
        _state.value = _state.value.copy(tasksState = LoadState.Content(tasks))
      } catch (_: Exception) {
        _state.value = _state.value.copy(
          tasksState = LoadState.Error(
            message = "Couldn't load tasks.",
            previousData = previous,
            updatedAtMillis = _state.value.tasksState.updatedAtOrNull(),
          )
        )
      } finally {
        recomputeSuggestedActions()
        completeRefreshLoad()
      }
    }
  }

  private fun loadProjects() {
    val previous = _state.value.projectsState.dataOrNull()
    if (previous == null) {
      _state.value = _state.value.copy(projectsState = LoadState.Loading)
    }
    viewModelScope.launch {
      try {
        val projects = todoistRepo.getProjects()
        _state.value = _state.value.copy(projectsState = LoadState.Content(projects))
      } catch (_: Exception) {
        _state.value = _state.value.copy(
          projectsState = LoadState.Error(
            message = "Couldn't load Todoist projects.",
            previousData = previous,
            updatedAtMillis = _state.value.projectsState.updatedAtOrNull(),
          )
        )
      } finally {
        recomputeSuggestedActions()
        completeRefreshLoad()
      }
    }
  }

  private fun loadEvents(daysAhead: Int = _state.value.eventWindowDays) {
    val previous = _state.value.eventsState.dataOrNull()
    if (previous == null) {
      _state.value = _state.value.copy(eventsState = LoadState.Loading)
    }
    viewModelScope.launch {
      try {
        val events = googleRepo.getCalendarEvents(daysAhead = daysAhead, maxResults = 250)
        _state.value = _state.value.copy(eventsState = LoadState.Content(events))
      } catch (_: Exception) {
        _state.value = _state.value.copy(
          eventsState = LoadState.Error(
            message = "Couldn't load calendar events.",
            previousData = previous,
            updatedAtMillis = _state.value.eventsState.updatedAtOrNull(),
          )
        )
      } finally {
        recomputeSuggestedActions()
        completeRefreshLoad()
      }
    }
  }

  private fun loadEmails() {
    val previous = _state.value.emailsState.dataOrNull()
    if (previous == null) {
      _state.value = _state.value.copy(emailsState = LoadState.Loading)
    }
    viewModelScope.launch {
      try {
        val emails = googleRepo.getGmailMessages()
        _state.value = _state.value.copy(emailsState = LoadState.Content(emails))
      } catch (_: Exception) {
        _state.value = _state.value.copy(
          emailsState = LoadState.Error(
            message = "Couldn't load Gmail messages.",
            previousData = previous,
            updatedAtMillis = _state.value.emailsState.updatedAtOrNull(),
          )
        )
      } finally {
        recomputeSuggestedActions()
        completeRefreshLoad()
      }
    }
  }

  private fun loadWhoop() {
    val previous = _state.value.whoopState.dataOrNull()
    if (previous == null) {
      _state.value = _state.value.copy(whoopState = LoadState.Loading)
    }
    viewModelScope.launch {
      try {
        val whoop = whoopRepo.getSummary()
        _state.value = _state.value.copy(whoopState = LoadState.Content(whoop))
      } catch (_: Exception) {
        _state.value = _state.value.copy(
          whoopState = LoadState.Error(
            message = "Couldn't load WHOOP summary.",
            previousData = previous,
            updatedAtMillis = _state.value.whoopState.updatedAtOrNull(),
          )
        )
      } finally {
        recomputeSuggestedActions()
        completeRefreshLoad()
      }
    }
  }

  private fun loadMarketData() {
    val previous = _state.value.marketState.dataOrNull()
    if (previous == null) {
      _state.value = _state.value.copy(marketState = LoadState.Loading)
    }
    viewModelScope.launch {
      try {
        val marketData = marketRepo?.getMarketDashboard() ?: MarketDashboardResponse()
        _state.value = _state.value.copy(marketState = LoadState.Content(marketData))
      } catch (_: Exception) {
        _state.value = _state.value.copy(
          marketState = LoadState.Error(
            message = "Couldn't load market data.",
            previousData = previous,
            updatedAtMillis = _state.value.marketState.updatedAtOrNull(),
          )
        )
      } finally {
        completeRefreshLoad()
      }
    }
  }

  private fun loadSports() {
    val previous = _state.value.sportsState.dataOrNull()
    if (previous == null) {
      _state.value = _state.value.copy(sportsState = LoadState.Loading)
    }
    viewModelScope.launch {
      try {
        val sportsData = sportsRepo?.getGames() ?: SportsResponse()
        _state.value = _state.value.copy(sportsState = LoadState.Content(sportsData))
      } catch (_: Exception) {
        _state.value = _state.value.copy(
          sportsState = LoadState.Error(
            message = "Couldn't load sports data.",
            previousData = previous,
            updatedAtMillis = _state.value.sportsState.updatedAtOrNull(),
          )
        )
      } finally {
        completeRefreshLoad()
      }
    }
  }

  private fun loadHealth() {
    val previous = _state.value.healthState.dataOrNull()
    if (previous == null) {
      _state.value = _state.value.copy(healthState = LoadState.Loading)
    }
    viewModelScope.launch {
      try {
        val metrics = metricsRepo?.getHistory(1)
        val todayMetric = metrics?.firstOrNull()
        val healthDisplay = if (todayMetric != null) {
          SamsungHealthDisplay(
            sleepTotalMinutes = todayMetric.samsungSleepHours?.let { (it * 60).toInt() },
            energyScore = todayMetric.samsungEnergyScore?.toInt(),
            steps = todayMetric.samsungSteps,
            activeCalories = null,
            heartRateAvg = null,
          )
        } else {
          null
        }
        _state.value = _state.value.copy(healthState = LoadState.Content(healthDisplay))
      } catch (_: Exception) {
        _state.value = _state.value.copy(
          healthState = LoadState.Error(
            message = "Couldn't load Samsung Health data.",
            previousData = previous,
            updatedAtMillis = _state.value.healthState.updatedAtOrNull(),
          )
        )
      } finally {
        recomputeSuggestedActions()
        completeRefreshLoad()
      }
    }
  }

  fun completeTask(taskId: String) {
    viewModelScope.launch {
      val currentTasks = _state.value.tasksState.dataOrNull().orEmpty()
      val nextTasks = currentTasks.filter { it.id != taskId }
      _state.value = _state.value.copy(tasksState = LoadState.Content(nextTasks))

      val ok = todoistRepo.completeTask(taskId)
      if (!ok) {
        _state.value = _state.value.copy(
          tasksState = LoadState.Error(
            message = "Couldn't complete task. Pull to refresh and try again.",
            previousData = currentTasks,
            updatedAtMillis = _state.value.tasksState.updatedAtOrNull(),
          )
        )
      }
      recomputeSuggestedActions()
    }
  }

  fun createTask(
    content: String,
    description: String? = null,
    projectId: String? = null,
    priority: Int? = null,
    dueDate: String? = null,
    dueString: String? = null,
    onError: (String) -> Unit = {},
    onSuccess: () -> Unit = {},
  ) {
    val title = content.trim()
    if (title.isBlank()) {
      onError("Task title is required.")
      return
    }
    viewModelScope.launch {
      val created = todoistRepo.createTask(
        content = title,
        description = description?.trim().takeIf { !it.isNullOrBlank() },
        projectId = projectId,
        priority = priority,
        dueString = dueString?.trim().takeIf { !it.isNullOrBlank() },
        dueDate = dueDate?.trim().takeIf { !it.isNullOrBlank() },
      )
      if (created == null) {
        onError("Could not create task.")
        return@launch
      }

      val tasks = _state.value.tasksState.dataOrNull().orEmpty()
      _state.value = _state.value.copy(tasksState = LoadState.Content(listOf(created) + tasks))
      recomputeSuggestedActions()
      onSuccess()
    }
  }

  fun markEmailRead(messageId: String) {
    viewModelScope.launch {
      val emails = _state.value.emailsState.dataOrNull().orEmpty()
      val nextEmails = emails.map { msg ->
        if (msg.id == messageId) msg.copy(labelIds = msg.labelIds - "UNREAD") else msg
      }
      _state.value = _state.value.copy(emailsState = LoadState.Content(nextEmails))

      val ok = googleRepo.markGmailAsRead(messageId)
      if (!ok) {
        _state.value = _state.value.copy(
          emailsState = LoadState.Error(
            message = "Couldn't mark email as read.",
            previousData = emails,
            updatedAtMillis = _state.value.emailsState.updatedAtOrNull(),
          )
        )
      }
      recomputeSuggestedActions()
    }
  }

  class Factory(private val container: AppContainer) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
      return DashboardViewModel(
        todoistRepo = container.todoistRepository,
        googleRepo = container.googleRepository,
        whoopRepo = container.whoopRepository,
        metricsRepo = container.metricsRepository,
        planRepo = container.planRepository,
        marketRepo = container.marketRepository,
        sportsRepo = container.sportsRepository,
      ) as T
    }
  }
}
