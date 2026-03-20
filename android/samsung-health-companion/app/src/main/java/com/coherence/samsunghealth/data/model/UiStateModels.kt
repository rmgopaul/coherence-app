package com.coherence.samsunghealth.data.model

import kotlinx.serialization.Serializable

@Serializable
data class DashboardHeroState(
  val greeting: String = "",
  val dateLabel: String = "",
  val tasksDueToday: Int = 0,
  val eventsToday: Int = 0,
  val recoveryPercent: Int? = null,
  val habitStreak: Int? = null,
)

data class WidgetShellState(
  val isLoading: Boolean = false,
  val error: String? = null,
  val lastUpdatedMillis: Long? = null,
  val isExpanded: Boolean = true,
)

@Serializable
data class SuggestionItem(
  val id: String,
  val title: String,
  val reason: String? = null,
  val actionType: String = "general",
  val actionPayload: String? = null,
  val score: Double? = null,
)

@Serializable
data class SearchResultItem(
  val id: String,
  val type: String,
  val title: String,
  val subtitle: String? = null,
  val url: String? = null,
  val timestamp: String? = null,
  val score: Double? = null,
)

@Serializable
data class GlobalSearchResponse(
  val query: String,
  val totalMatched: Int = 0,
  val items: List<SearchResultItem> = emptyList(),
)
