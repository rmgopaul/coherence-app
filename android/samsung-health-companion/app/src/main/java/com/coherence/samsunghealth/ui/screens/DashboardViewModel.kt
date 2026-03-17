package com.coherence.samsunghealth.ui.screens

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.coherence.samsunghealth.data.model.CalendarEvent
import com.coherence.samsunghealth.data.model.GmailMessage
import com.coherence.samsunghealth.data.model.SamsungHealthDisplay
import com.coherence.samsunghealth.data.model.TodoistTask
import com.coherence.samsunghealth.data.model.WhoopSummary
import com.coherence.samsunghealth.data.repository.GoogleRepository
import com.coherence.samsunghealth.data.repository.MetricsRepository
import com.coherence.samsunghealth.data.repository.PlanRepository
import com.coherence.samsunghealth.data.repository.TodoistRepository
import com.coherence.samsunghealth.data.repository.WhoopRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class DashboardState(
  val tasks: List<TodoistTask> = emptyList(),
  val events: List<CalendarEvent> = emptyList(),
  val emails: List<GmailMessage> = emptyList(),
  val whoop: WhoopSummary? = null,
  val health: SamsungHealthDisplay? = null,
  val tasksLoading: Boolean = true,
  val eventsLoading: Boolean = true,
  val emailsLoading: Boolean = true,
  val whoopLoading: Boolean = true,
  val healthLoading: Boolean = true,
  val isRefreshing: Boolean = false,
  val planOverview: String? = null,
  val planGenerating: Boolean = false,
  val planError: String? = null,
)

class DashboardViewModel(
  private val todoistRepo: TodoistRepository,
  private val googleRepo: GoogleRepository,
  private val whoopRepo: WhoopRepository,
  private val metricsRepo: MetricsRepository? = null,
  private val planRepo: PlanRepository? = null,
) : ViewModel() {

  private val _state = MutableStateFlow(DashboardState())
  val state: StateFlow<DashboardState> = _state.asStateFlow()

  init {
    loadAll()
  }

  fun loadAll() {
    loadTasks()
    loadEvents()
    loadEmails()
    loadWhoop()
    loadHealth()
  }

  fun refresh() {
    _state.value = _state.value.copy(isRefreshing = true)
    loadAll()
  }

  fun generatePlan() {
    if (_state.value.planGenerating) return
    viewModelScope.launch {
      _state.value = _state.value.copy(planGenerating = true, planError = null)
      try {
        val today = java.time.LocalDate.now().format(java.time.format.DateTimeFormatter.ISO_LOCAL_DATE)
        val currentState = _state.value
        Log.d("DashboardVM", "Generating plan for $today with ${currentState.tasks.size} tasks, ${currentState.events.size} events")
        val result = planRepo?.generateDailyOverview(
          date = today,
          taskSummaries = currentState.tasks.map { it.content },
          eventSummaries = currentState.events.mapNotNull { it.summary },
          emailSummaries = currentState.emails.mapNotNull { msg ->
            msg.payload?.headers?.firstOrNull { it.name.equals("Subject", ignoreCase = true) }?.value
          },
        )
        if (result != null) {
          _state.value = _state.value.copy(planOverview = result, planGenerating = false)
        } else {
          _state.value = _state.value.copy(planGenerating = false, planError = "Failed to generate plan. Try again.")
        }
      } catch (e: Exception) {
        Log.e("DashboardVM", "Plan generation failed", e)
        _state.value = _state.value.copy(planGenerating = false, planError = "Error: ${e.message?.take(100)}")
      }
    }
  }

  private fun loadTasks() {
    viewModelScope.launch {
      _state.value = _state.value.copy(tasksLoading = true)
      try {
        val tasks = todoistRepo.getTasks()
        _state.value = _state.value.copy(tasks = tasks, tasksLoading = false, isRefreshing = false)
      } catch (_: Exception) {
        _state.value = _state.value.copy(tasksLoading = false, isRefreshing = false)
      }
    }
  }

  private fun loadEvents() {
    viewModelScope.launch {
      _state.value = _state.value.copy(eventsLoading = true)
      try {
        val events = googleRepo.getCalendarEvents()
        _state.value = _state.value.copy(events = events, eventsLoading = false)
      } catch (_: Exception) {
        _state.value = _state.value.copy(eventsLoading = false)
      }
    }
  }

  private fun loadEmails() {
    viewModelScope.launch {
      _state.value = _state.value.copy(emailsLoading = true)
      try {
        val emails = googleRepo.getGmailMessages()
        _state.value = _state.value.copy(emails = emails, emailsLoading = false)
      } catch (_: Exception) {
        _state.value = _state.value.copy(emailsLoading = false)
      }
    }
  }

  private fun loadWhoop() {
    viewModelScope.launch {
      _state.value = _state.value.copy(whoopLoading = true)
      try {
        val whoop = whoopRepo.getSummary()
        _state.value = _state.value.copy(whoop = whoop, whoopLoading = false)
      } catch (_: Exception) {
        _state.value = _state.value.copy(whoopLoading = false)
      }
    }
  }

  private fun loadHealth() {
    viewModelScope.launch {
      _state.value = _state.value.copy(healthLoading = true)
      try {
        val metrics = metricsRepo?.getHistory(1)
        val todayMetric = metrics?.firstOrNull()
        if (todayMetric != null) {
          val healthDisplay = SamsungHealthDisplay(
            sleepTotalMinutes = todayMetric.samsungSleepHours?.let { (it * 60).toInt() },
            energyScore = todayMetric.samsungEnergyScore?.toInt(),
            steps = todayMetric.samsungSteps,
            activeCalories = null,
            heartRateAvg = null,
          )
          _state.value = _state.value.copy(health = healthDisplay, healthLoading = false)
        } else {
          _state.value = _state.value.copy(healthLoading = false)
        }
      } catch (_: Exception) {
        _state.value = _state.value.copy(healthLoading = false)
      }
    }
  }

  fun completeTask(taskId: String) {
    viewModelScope.launch {
      todoistRepo.completeTask(taskId)
      _state.value = _state.value.copy(
        tasks = _state.value.tasks.filter { it.id != taskId },
      )
    }
  }

  fun markEmailRead(messageId: String) {
    viewModelScope.launch {
      googleRepo.markGmailAsRead(messageId)
      _state.value = _state.value.copy(
        emails = _state.value.emails.map { msg ->
          if (msg.id == messageId) msg.copy(labelIds = msg.labelIds - "UNREAD") else msg
        },
      )
    }
  }
}
