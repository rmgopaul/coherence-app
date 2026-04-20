package com.coherence.healthconnect.data.model

import kotlinx.serialization.Serializable

@Serializable
data class SportsResponse(
  val games: List<GameInfo> = emptyList(),
  val fetchedAt: String? = null,
  val stale: Boolean = false,
)

@Serializable
data class GameInfo(
  val id: String,
  val league: String,
  val teamName: String,
  val teamAbbreviation: String,
  val teamLogo: String = "",
  val teamColor: String = "",
  val teamRecord: String = "",
  val opponentName: String,
  val opponentAbbreviation: String = "",
  val opponentLogo: String = "",
  val opponentRecord: String = "",
  val isHome: Boolean = true,
  val venue: String = "",
  val city: String = "",
  val gameTime: String = "",
  val gameTimeFormatted: String = "",
  val status: String = "pre",
  val statusDetail: String = "",
  val period: String = "",
  val clock: String = "",
  val teamScore: Int? = null,
  val opponentScore: Int? = null,
  val broadcasts: List<String> = emptyList(),
  val teamWinning: Boolean = false,
)
