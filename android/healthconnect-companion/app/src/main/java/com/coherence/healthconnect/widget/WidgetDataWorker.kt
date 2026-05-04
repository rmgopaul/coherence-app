package com.coherence.healthconnect.widget

import android.content.Context
import android.util.Log
import androidx.glance.appwidget.updateAll
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.coherence.healthconnect.CoherenceApplication
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

class WidgetDataWorker(
  private val context: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(context, workerParams) {

  companion object {
    private const val TAG = "WidgetDataWorker"
    private const val PERIODIC_WORK_NAME = "coherence_widget_refresh"

    private val CRYPTO_SYMBOLS = setOf("BTC-USD", "ETH-USD", "SOL-USD", "DOGE-USD")

    fun enqueuePeriodicRefresh(context: Context) {
      val constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

      val request = PeriodicWorkRequestBuilder<WidgetDataWorker>(30, TimeUnit.MINUTES)
        .setConstraints(constraints)
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 5, TimeUnit.MINUTES)
        .build()

      WorkManager.getInstance(context).enqueueUniquePeriodicWork(
        PERIODIC_WORK_NAME,
        ExistingPeriodicWorkPolicy.KEEP,
        request,
      )
    }

    fun enqueueOneTimeRefresh(context: Context) {
      val constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

      val request = OneTimeWorkRequestBuilder<WidgetDataWorker>()
        .setConstraints(constraints)
        .build()

      WorkManager.getInstance(context).enqueue(request)
    }
  }

  override suspend fun doWork(): Result {
    return try {
      val outcome = fetchWidgetData()
      when (outcome) {
        is FetchOutcome.AllFailed -> {
          // Every network-bound fetch threw — almost always a
          // transient connectivity drop (DNS / WiFi handoff / brief
          // airplane mode). Don't save: clobbering the cache with
          // empty fields wipes the previously-good data and the
          // user sees a black widget until the next periodic tick
          // ~30 minutes later. Just retry; the widgets keep
          // displaying whatever they last had.
          Log.w(
            TAG,
            "All widget fetches failed (likely transient network); skipping save and retrying. Sample: " +
              outcome.firstException::class.java.simpleName +
              " — " +
              (outcome.firstException.message?.take(120) ?: ""),
          )
          if (runAttemptCount < 3) Result.retry() else Result.success()
        }
        is FetchOutcome.Ok -> {
          WidgetDataStore.save(context, outcome.data)
          // All four widget classes read from the same
          // WidgetDataStore cache; we issue updateAll() against each
          // so a single worker tick repaints whichever combination
          // the user has placed. updateAll() is a no-op when no
          // instance of a class is bound, so this is safe regardless
          // of which widgets exist.
          CoherenceDashboardWidget().updateAll(context)
          CoherenceKingWidget().updateAll(context)
          CoherenceKingLeftWidget().updateAll(context)
          CoherenceKingRightWidget().updateAll(context)
          CoherenceHabitsWidget().updateAll(context)
          Result.success()
        }
      }
    } catch (e: Exception) {
      Log.e(TAG, "Widget data fetch failed", e)
      // Save partial data with error
      val existing = WidgetDataStore.load(context)
      WidgetDataStore.save(context, existing.copy(error = e.message?.take(80)))
      try { CoherenceDashboardWidget().updateAll(context) } catch (_: Exception) {}
      try { CoherenceKingWidget().updateAll(context) } catch (_: Exception) {}
      try { CoherenceKingLeftWidget().updateAll(context) } catch (_: Exception) {}
      try { CoherenceKingRightWidget().updateAll(context) } catch (_: Exception) {}
      try { CoherenceHabitsWidget().updateAll(context) } catch (_: Exception) {}
      if (runAttemptCount < 3) Result.retry() else Result.failure()
    }
  }

  /**
   * Result of a widget-fetch run. Distinguishes "every network call
   * failed" (probably transient — don't clobber the cache) from
   * "got at least some data" (write the full payload as before).
   */
  private sealed class FetchOutcome {
    data class Ok(val data: WidgetData) : FetchOutcome()
    data class AllFailed(val firstException: Throwable) : FetchOutcome()
  }

  private suspend fun fetchWidgetData(): FetchOutcome {
    val app = context.applicationContext as CoherenceApplication

    val todayKey = LocalDate.now().format(DateTimeFormatter.ISO_LOCAL_DATE)
    val now = System.currentTimeMillis()

    // Run each fetch under runCatching so one provider's failure
    // doesn't take the whole tick down. We keep the Result<T> objects
    // (rather than collapsing to defaults) so we can distinguish a
    // legitimate empty-but-online result from a network-error result
    // and skip the save in the latter case.
    val headlinesR = runCatching { fetchHeadlines(app) }
    val tickersR = runCatching { fetchTickers(app) }
    val sportsR = runCatching { fetchSports(app) }
    val emailsR = runCatching { fetchEmails(app) }
    val tasksR = runCatching { fetchTasks(app, todayKey) }
    val upcomingEventsR = runCatching { fetchUpcomingEvents(app) }
    val kingR = runCatching { fetchKingOfDay(app, todayKey) }
    val habitsR = runCatching { fetchHabits(app, todayKey) }

    val networkResults = listOf(
      headlinesR, tickersR, sportsR, emailsR, tasksR, upcomingEventsR, kingR, habitsR,
    )
    val anySuccess = networkResults.any { it.isSuccess }
    if (!anySuccess) {
      val firstFailure = networkResults.firstNotNullOfOrNull { it.exceptionOrNull() }
        ?: RuntimeException("all fetches failed")
      return FetchOutcome.AllFailed(firstFailure)
    }

    val headlines = headlinesR.getOrDefault(emptyList())
    val tickers = tickersR.getOrDefault(emptyList())
    val sports = sportsR.getOrDefault(emptyList())
    val emails = emailsR.getOrDefault(emptyList())
    val tasks = tasksR.getOrDefault(emptyList())
    // King · Left renders multiple upcoming events; the rest only
    // need the next one. Fetch the full list once and let each widget
    // take what it wants from the cached WidgetData. `nextEvent` is
    // retained as a convenience field for backward compat.
    val upcomingEvents = upcomingEventsR.getOrDefault(emptyList())
    val weather = runCatching { extractWeather(headlines) }.getOrNull()
    val king = kingR.getOrNull()
    val habits = habitsR.getOrDefault(emptyList())

    // Cache more rows than any single widget needs so King · Left
    // (which surfaces top 9 tasks / top 7 emails / top 4 events) has
    // enough material; smaller widgets just `.take(3)` from here.
    return FetchOutcome.Ok(
      WidgetData(
        headlines = headlines.take(15),
        weatherSummary = weather,
        tickers = tickers.take(20),
        sports = sports.take(6),
        emails = emails.take(10),
        tasks = tasks.take(12),
        nextEvent = upcomingEvents.firstOrNull(),
        events = upcomingEvents.take(6),
        kingOfDayTitle = king?.title,
        kingOfDayReason = king?.reason,
        kingOfDaySource = king?.source,
        habits = habits,
        habitsDateKey = todayKey,
        updatedAtMillis = now,
      ),
    )
  }

  /**
   * Phase G — pull the King of the Day from `trpc.kingOfDay.get` so the
   * Glance widget can show it as the headline. Defensively typed (the
   * route is shipped but we treat absence as "no king").
   */
  private data class KingOfDay(
    val title: String,
    val reason: String?,
    val source: String?,
  )

  private suspend fun fetchKingOfDay(
    app: CoherenceApplication,
    todayKey: String,
  ): KingOfDay? {
    val input = buildJsonObject {
      put("dateKey", JsonPrimitive(todayKey))
    }
    val response = app.container.trpcClient.query("kingOfDay.get", input)
    val obj = response as? JsonObject ?: return null
    val title = (obj["title"] as? JsonPrimitive)?.contentOrNull ?: return null
    val reason = (obj["reason"] as? JsonPrimitive)?.contentOrNull
    val source = (obj["source"] as? JsonPrimitive)?.contentOrNull
    return KingOfDay(title = title, reason = reason, source = source)
  }

  private suspend fun fetchHeadlines(app: CoherenceApplication): List<WidgetHeadline> {
    val market = app.container.marketRepository.getMarketDashboard()
    return market.headlines.take(5).map { h ->
      WidgetHeadline(title = h.title, source = h.source)
    }
  }

  private fun extractWeather(headlines: List<WidgetHeadline>): String? {
    // Weather may come from headlines tagged as weather, or we return null
    return headlines.firstOrNull { it.source.contains("weather", ignoreCase = true) }?.title
  }

  private suspend fun fetchTickers(app: CoherenceApplication): List<WidgetTicker> {
    val market = app.container.marketRepository.getMarketDashboard()
    return market.quotes.map { q ->
      WidgetTicker(
        symbol = q.symbol.replace("-USD", ""),
        price = formatPrice(q.price),
        changePercent = formatPercent(q.changePercent),
        isPositive = q.changePercent >= 0,
        isCrypto = q.symbol in CRYPTO_SYMBOLS || q.currency != "USD",
      )
    }
  }

  private suspend fun fetchSports(app: CoherenceApplication): List<WidgetGame> {
    val sports = app.container.sportsRepository.getGames()
    return sports.games.map { g ->
      val teams = if (g.isHome) "${g.opponentAbbreviation} @ ${g.teamAbbreviation}"
      else "${g.teamAbbreviation} @ ${g.opponentAbbreviation}"

      val score = when (g.status) {
        "post" -> "${g.teamScore ?: 0}-${g.opponentScore ?: 0}"
        "in", "halftime" -> "${g.teamScore ?: 0}-${g.opponentScore ?: 0} ${g.clock}"
        else -> g.gameTimeFormatted.ifBlank { g.statusDetail }
      }

      WidgetGame(
        league = g.league.uppercase(),
        teams = teams,
        score = score,
        status = g.status,
      )
    }
  }

  private suspend fun fetchEmails(app: CoherenceApplication): List<WidgetEmail> {
    val messages = app.container.googleRepository.getGmailMessages(maxResults = 3)
    return messages.map { m ->
      val fromRaw = m.from
      val fromName = if (fromRaw.contains("<")) fromRaw.substringBefore("<").trim()
      else fromRaw.substringBefore("@").trim()

      WidgetEmail(
        from = fromName.take(20),
        subject = m.subject.take(50),
        isUnread = m.isUnread,
      )
    }
  }

  private suspend fun fetchTasks(app: CoherenceApplication, todayKey: String): List<WidgetTask> {
    val allTasks = app.container.todoistRepository.getTasks()
    val todayTasks = allTasks
      .filter { t -> t.due != null && t.due.date <= todayKey }
      .sortedByDescending { it.priority }
    // Return the full filtered list — caller's `.take(N)` decides how
    // many to display per widget.
    return todayTasks.map { t ->
      WidgetTask(title = t.content.take(50), priority = t.priority)
    }
  }

  /**
   * All upcoming calendar events within the look-ahead window,
   * sorted by start time. Smaller widgets call `.firstOrNull()` for
   * a single next-event card; King · Left renders the first 4.
   */
  private suspend fun fetchUpcomingEvents(app: CoherenceApplication): List<WidgetCalendarEvent> {
    val events = app.container.googleRepository.getCalendarEvents(daysAhead = 4, maxResults = 20)
    val now = System.currentTimeMillis()
    return events
      .mapNotNull { event ->
        val millis = parseEventMillis(event.start?.dateTime, event.start?.date) ?: return@mapNotNull null
        if (millis < now) return@mapNotNull null
        Triple(event, millis, formatEventTime(event.start?.dateTime, event.start?.date))
      }
      .sortedBy { it.second }
      .map { (event, _, timeStr) ->
        WidgetCalendarEvent(
          title = (event.summary ?: "Untitled").take(40),
          time = timeStr,
          location = event.location?.take(30) ?: "",
        )
      }
  }

  /**
   * Build the habit tile list for the dedicated habits widget. We need
   * BOTH `getForDate` (for today's completion state + the active list,
   * already filtered by `isActive`) AND `getStreaks` (for the rolling
   * streak count rendered on each tile). Streaks come back as a flat
   * list keyed by `habitId`; we fold them into a map and zip.
   *
   * Failures in either call collapse the list to empty rather than
   * showing a half-populated UI; the caller's surrounding runCatching
   * keeps a network outage from clobbering the rest of the snapshot.
   */
  private suspend fun fetchHabits(
    app: CoherenceApplication,
    todayKey: String,
  ): List<WidgetHabit> {
    val today = app.container.habitsRepository.getForDate(todayKey)
    if (today.isEmpty()) return emptyList()
    val streaksByHabitId = app.container.habitsRepository.getStreaks()
      .associateBy({ it.habitId }, { it.streak })
    return today
      .filter { it.isActive }
      .sortedBy { it.sortOrder }
      .map { habit ->
        WidgetHabit(
          id = habit.id,
          name = habit.name,
          color = habit.color,
          completed = habit.completed,
          streak = streaksByHabitId[habit.id] ?: 0,
        )
      }
  }

  private fun parseEventMillis(dateTime: String?, date: String?): Long? {
    if (!dateTime.isNullOrBlank()) {
      return runCatching { Instant.parse(dateTime).toEpochMilli() }.getOrNull()
    }
    if (!date.isNullOrBlank()) {
      return runCatching {
        LocalDate.parse(date).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
      }.getOrNull()
    }
    return null
  }

  private fun formatEventTime(dateTime: String?, date: String?): String {
    if (!dateTime.isNullOrBlank()) {
      return runCatching {
        val zdt = ZonedDateTime.ofInstant(Instant.parse(dateTime), ZoneId.systemDefault())
        zdt.format(DateTimeFormatter.ofPattern("h:mm a"))
      }.getOrDefault(dateTime)
    }
    if (!date.isNullOrBlank()) return "All day"
    return ""
  }

  private fun formatPrice(price: Double): String {
    return if (price >= 1000) {
      String.format("%.0f", price)
    } else if (price >= 1) {
      String.format("%.2f", price)
    } else {
      String.format("%.4f", price)
    }
  }

  private fun formatPercent(pct: Double): String {
    val sign = if (pct >= 0) "+" else ""
    return "$sign${String.format("%.1f", pct)}%"
  }
}
