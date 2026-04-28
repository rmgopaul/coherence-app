package com.coherence.healthconnect.widget

import kotlinx.serialization.Serializable

/**
 * Snapshot of dashboard data stored in DataStore for the home-screen widget.
 * Kept deliberately flat/simple so serialisation is cheap.
 */
@Serializable
data class WidgetData(
  // Headlines
  val headlines: List<WidgetHeadline> = emptyList(),

  // Weather (sourced from market headlines or a dedicated field)
  val weatherSummary: String? = null,

  // Market tickers (stocks + crypto)
  val tickers: List<WidgetTicker> = emptyList(),

  // Sports
  val sports: List<WidgetGame> = emptyList(),

  // Gmail – most recent 3
  val emails: List<WidgetEmail> = emptyList(),

  // Tasks – top 3 due today
  val tasks: List<WidgetTask> = emptyList(),

  // Next calendar event — kept for backward compat with the
  // existing dashboard + single-king widgets that only render one.
  val nextEvent: WidgetCalendarEvent? = null,

  // Up-next calendar events — used by the King · Left widget which
  // has the room for a multi-event list. `events[0]` mirrors
  // `nextEvent` for the simpler widgets; King · Left renders the
  // first 4. Older serialized payloads without this field default
  // to empty (kotlinx-serialization @Serializable uses the default).
  val events: List<WidgetCalendarEvent> = emptyList(),

  // Phase G — King of the Day, surfaced as the widget headline so the
  // user sees their one thing without opening the app. `kingOfDaySource`
  // is "auto" / "manual" / "ai" — exposed so the UI can show a tiny
  // PINNED chip when the user manually pinned the day's headline.
  val kingOfDayTitle: String? = null,
  val kingOfDayReason: String? = null,
  val kingOfDaySource: String? = null,

  // Metadata
  val updatedAtMillis: Long = 0L,
  val error: String? = null,
)

@Serializable
data class WidgetHeadline(
  val title: String,
  val source: String = "",
)

@Serializable
data class WidgetTicker(
  val symbol: String,
  val price: String,
  val changePercent: String,
  val isPositive: Boolean,
  val isCrypto: Boolean = false,
)

@Serializable
data class WidgetGame(
  val league: String,
  val teams: String,       // e.g. "MIN vs LAL"
  val score: String,       // e.g. "105-98" or "7:00 PM"
  val status: String,      // pre, in, post
)

@Serializable
data class WidgetEmail(
  val from: String,
  val subject: String,
  val isUnread: Boolean,
)

@Serializable
data class WidgetTask(
  val title: String,
  val priority: Int,
)

@Serializable
data class WidgetCalendarEvent(
  val title: String,
  val time: String,
  val location: String = "",
)
