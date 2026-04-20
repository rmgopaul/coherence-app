package com.coherence.healthconnect.data.model

import kotlinx.serialization.Serializable

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
