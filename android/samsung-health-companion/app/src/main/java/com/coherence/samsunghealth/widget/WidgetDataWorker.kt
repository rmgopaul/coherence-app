package com.coherence.samsunghealth.widget

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
import com.coherence.samsunghealth.CoherenceApplication
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
      val data = fetchWidgetData()
      WidgetDataStore.save(context, data)
      CoherenceDashboardWidget().updateAll(context)
      Result.success()
    } catch (e: Exception) {
      Log.e(TAG, "Widget data fetch failed", e)
      // Save partial data with error
      val existing = WidgetDataStore.load(context)
      WidgetDataStore.save(context, existing.copy(error = e.message?.take(80)))
      try { CoherenceDashboardWidget().updateAll(context) } catch (_: Exception) {}
      if (runAttemptCount < 3) Result.retry() else Result.failure()
    }
  }

  private suspend fun fetchWidgetData(): WidgetData {
    val app = context.applicationContext as CoherenceApplication

    val todayKey = LocalDate.now().format(DateTimeFormatter.ISO_LOCAL_DATE)
    val now = System.currentTimeMillis()

    // Fetch all data sources in parallel-ish (coroutine sequential but fast)
    val headlines = runCatching { fetchHeadlines(app) }.getOrDefault(emptyList())
    val tickers = runCatching { fetchTickers(app) }.getOrDefault(emptyList())
    val sports = runCatching { fetchSports(app) }.getOrDefault(emptyList())
    val emails = runCatching { fetchEmails(app) }.getOrDefault(emptyList())
    val tasks = runCatching { fetchTasks(app, todayKey) }.getOrDefault(emptyList())
    val nextEvent = runCatching { fetchNextEvent(app) }.getOrNull()
    val weather = runCatching { extractWeather(headlines) }.getOrNull()

    return WidgetData(
      headlines = headlines.take(4),
      weatherSummary = weather,
      tickers = tickers.take(9),
      sports = sports.take(3),
      emails = emails.take(3),
      tasks = tasks.take(3),
      nextEvent = nextEvent,
      updatedAtMillis = now,
    )
  }

  private suspend fun fetchHeadlines(app: CoherenceApplication): List<WidgetHeadline> {
    val market = app.marketRepository.getMarketDashboard()
    return market.headlines.take(5).map { h ->
      WidgetHeadline(title = h.title, source = h.source)
    }
  }

  private fun extractWeather(headlines: List<WidgetHeadline>): String? {
    // Weather may come from headlines tagged as weather, or we return null
    return headlines.firstOrNull { it.source.contains("weather", ignoreCase = true) }?.title
  }

  private suspend fun fetchTickers(app: CoherenceApplication): List<WidgetTicker> {
    val market = app.marketRepository.getMarketDashboard()
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
    val sports = app.sportsRepository.getGames()
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
    val messages = app.googleRepository.getGmailMessages(maxResults = 3)
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
    val allTasks = app.todoistRepository.getTasks()
    val todayTasks = allTasks
      .filter { t -> t.due != null && t.due.date <= todayKey }
      .sortedByDescending { it.priority }
    return todayTasks.take(3).map { t ->
      WidgetTask(title = t.content.take(50), priority = t.priority)
    }
  }

  private suspend fun fetchNextEvent(app: CoherenceApplication): WidgetCalendarEvent? {
    val events = app.googleRepository.getCalendarEvents(daysAhead = 2, maxResults = 10)
    val now = System.currentTimeMillis()

    return events
      .mapNotNull { event ->
        val millis = parseEventMillis(event.start?.dateTime, event.start?.date) ?: return@mapNotNull null
        if (millis < now) return@mapNotNull null
        Triple(event, millis, formatEventTime(event.start?.dateTime, event.start?.date))
      }
      .minByOrNull { it.second }
      ?.let { (event, _, timeStr) ->
        WidgetCalendarEvent(
          title = (event.summary ?: "Untitled").take(40),
          time = timeStr,
          location = event.location?.take(30) ?: "",
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
