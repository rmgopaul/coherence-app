package com.coherence.healthconnect.data.model

import kotlinx.serialization.Serializable

@Serializable
data class MarketDashboardResponse(
  val quotes: List<MarketQuote> = emptyList(),
  val headlines: List<MarketHeadline> = emptyList(),
  val approvalRatings: List<ApprovalRatingSource> = emptyList(),
  val fetchedAt: String? = null,
  val marketRateLimited: Boolean = false,
  val usingStaleQuotes: Boolean = false,
)

@Serializable
data class MarketQuote(
  val symbol: String,
  val shortName: String = "",
  val price: Double = 0.0,
  val previousClose: Double = 0.0,
  val change: Double = 0.0,
  val changePercent: Double = 0.0,
  val currency: String = "USD",
  val marketState: String = "CLOSED",
)

@Serializable
data class MarketHeadline(
  val title: String = "",
  val link: String = "",
  val source: String = "",
  val pubDate: String = "",
  val category: String = "",
)

@Serializable
data class ApprovalRatingSource(
  val source: String = "",
  val approve: Double? = null,
  val disapprove: Double? = null,
  val net: Double? = null,
  val asOf: String? = null,
  val url: String = "",
  val error: String? = null,
)
