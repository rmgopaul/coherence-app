package com.coherence.healthconnect.data.model

import kotlinx.serialization.Serializable

// ── Supplements ──

@Serializable
data class SupplementDefinition(
  val id: String,
  val name: String,
  val brand: String? = null,
  val dose: String,
  val doseUnit: String = "capsule",
  val dosePerUnit: String? = null,
  val timing: String = "am",
  val isLocked: Boolean = false,
  val isActive: Boolean = true,
  val sortOrder: Int = 0,
)

@Serializable
data class SupplementLog(
  val id: String,
  val definitionId: String? = null,
  val name: String,
  val dose: String,
  val doseUnit: String = "capsule",
  val timing: String = "am",
  val autoLogged: Boolean = false,
  val notes: String? = null,
  val dateKey: String,
)

// ── Habits ──

@Serializable
data class HabitDefinition(
  val id: String,
  val name: String,
  val color: String = "slate",
  val sortOrder: Int = 0,
  val isActive: Boolean = true,
)

@Serializable
data class HabitWithCompletion(
  val id: String,
  val name: String,
  val color: String = "slate",
  val sortOrder: Int = 0,
  val isActive: Boolean = true,
  val completed: Boolean = false,
  val dateKey: String? = null,
)

@Serializable
data class HabitCalendarDay(
  val dateKey: String,
  val completed: Boolean,
)

@Serializable
data class HabitStreak(
  val habitId: String,
  val name: String,
  val color: String,
  val streak: Int,
  val calendar: List<HabitCalendarDay> = emptyList(),
)

// ── Notes ──

@Serializable
data class Note(
  val id: String,
  val notebook: String = "General",
  val title: String,
  val content: String = "",
  val pinned: Boolean = false,
  val createdAt: String? = null,
  val updatedAt: String? = null,
)

@Serializable
data class NoteCreateResult(
  val success: Boolean,
  val noteId: String,
)

// ── Metrics / Daily Log ──

@Serializable
data class DailyHealthMetric(
  val id: String,
  val dateKey: String,
  val whoopRecoveryScore: Double? = null,
  val whoopDayStrain: Double? = null,
  val whoopSleepHours: Double? = null,
  val whoopHrvMs: Double? = null,
  val whoopRestingHr: Double? = null,
  val samsungSteps: Int? = null,
  val samsungSleepHours: Double? = null,
  val samsungSpo2AvgPercent: Double? = null,
  val samsungSleepScore: Double? = null,
  val samsungEnergyScore: Double? = null,
  val todoistCompletedCount: Int? = null,
)

@Serializable
data class TrendSeriesPoint(
  val dateKey: String,
  val value: Double? = null,
)

@Serializable
data class TrendDateRange(
  val startDateKey: String? = null,
  val endDateKey: String? = null,
)

@Serializable
data class TrendSeriesCollection(
  val recovery: List<TrendSeriesPoint> = emptyList(),
  val sleepHours: List<TrendSeriesPoint> = emptyList(),
  val strain: List<TrendSeriesPoint> = emptyList(),
  val hrvMs: List<TrendSeriesPoint> = emptyList(),
  val steps: List<TrendSeriesPoint> = emptyList(),
  val tasksCompleted: List<TrendSeriesPoint> = emptyList(),
)

@Serializable
data class TrendCorrelations(
  val recoveryVsSleep: Double? = null,
  val recoveryVsTasksCompleted: Double? = null,
)

@Serializable
data class TrendSeriesResponse(
  val days: Int = 30,
  val dateRange: TrendDateRange = TrendDateRange(),
  val pointCount: Int = 0,
  val series: TrendSeriesCollection = TrendSeriesCollection(),
  val correlations: TrendCorrelations = TrendCorrelations(),
)
