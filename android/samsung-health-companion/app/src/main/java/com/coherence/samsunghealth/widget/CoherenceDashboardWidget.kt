package com.coherence.samsunghealth.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.coherence.samsunghealth.MainActivity
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import android.graphics.Color as AndroidColor

class CoherenceDashboardWidget : GlanceAppWidget() {

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val data = WidgetDataStore.load(context)
    provideContent {
      GlanceTheme {
        WidgetContent(data)
      }
    }
  }
}

// ── Color palette ──────────────────────────────────────────────────────────────

private val BgDark = ColorProvider(AndroidColor.parseColor("#121212"))
private val BgCard = ColorProvider(AndroidColor.parseColor("#1E1E1E"))
private val TextPrimary = ColorProvider(AndroidColor.parseColor("#ECEFF1"))
private val TextSecondary = ColorProvider(AndroidColor.parseColor("#9E9E9E"))
private val AccentBlue = ColorProvider(AndroidColor.parseColor("#8AB4F8"))
private val AccentGreen = ColorProvider(AndroidColor.parseColor("#81C784"))
private val AccentRed = ColorProvider(AndroidColor.parseColor("#EF9A9A"))
private val AccentOrange = ColorProvider(AndroidColor.parseColor("#FFB74D"))
private val AccentPurple = ColorProvider(AndroidColor.parseColor("#CE93D8"))
private val DividerColor = ColorProvider(AndroidColor.parseColor("#2A2A2A"))

// ── Styles ─────────────────────────────────────────────────────────────────────

private val SectionTitleStyle = TextStyle(
  color = AccentBlue,
  fontSize = 11.sp,
  fontWeight = FontWeight.Bold,
)

private val BodyStyle = TextStyle(
  color = TextPrimary,
  fontSize = 12.sp,
)

private val SecondaryStyle = TextStyle(
  color = TextSecondary,
  fontSize = 10.sp,
)

// ── Main content ───────────────────────────────────────────────────────────────

@Composable
private fun WidgetContent(data: WidgetData) {
  Box(
    modifier = GlanceModifier
      .fillMaxSize()
      .background(BgDark)
      .clickable(actionStartActivity<MainActivity>())
      .cornerRadius(16.dp),
  ) {
    LazyColumn(
      modifier = GlanceModifier
        .fillMaxSize()
        .padding(12.dp),
    ) {
      // Header
      item { WidgetHeader(data.updatedAtMillis) }
      item { Divider() }

      // Next Calendar Event
      if (data.nextEvent != null) {
        item { NextEventSection(data.nextEvent) }
        item { Divider() }
      }

      // Tasks due today
      if (data.tasks.isNotEmpty()) {
        item { TasksSection(data.tasks) }
        item { Divider() }
      }

      // Emails
      if (data.emails.isNotEmpty()) {
        item { EmailsSection(data.emails) }
        item { Divider() }
      }

      // Market tickers
      if (data.tickers.isNotEmpty()) {
        item { TickersSection(data.tickers) }
        item { Divider() }
      }

      // Headlines
      if (data.headlines.isNotEmpty()) {
        item { HeadlinesSection(data.headlines) }
        item { Divider() }
      }

      // Weather
      if (data.weatherSummary != null) {
        item { WeatherSection(data.weatherSummary) }
        item { Divider() }
      }

      // Sports
      if (data.sports.isNotEmpty()) {
        item { SportsSection(data.sports) }
      }

      // Error footer
      if (data.error != null) {
        item {
          Text(
            text = data.error,
            style = TextStyle(color = AccentRed, fontSize = 9.sp),
            modifier = GlanceModifier.padding(top = 4.dp),
          )
        }
      }
    }
  }
}

// ── Header ─────────────────────────────────────────────────────────────────────

@Composable
private fun WidgetHeader(updatedAtMillis: Long) {
  Row(
    modifier = GlanceModifier.fillMaxWidth().padding(bottom = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      text = "Coherence",
      style = TextStyle(
        color = AccentBlue,
        fontSize = 14.sp,
        fontWeight = FontWeight.Bold,
      ),
    )
    Spacer(modifier = GlanceModifier.defaultWeight())
    if (updatedAtMillis > 0) {
      val fmt = SimpleDateFormat("h:mm a", Locale.getDefault())
      Text(
        text = fmt.format(Date(updatedAtMillis)),
        style = SecondaryStyle,
      )
    }
  }
}

// ── Next Event ─────────────────────────────────────────────────────────────────

@Composable
private fun NextEventSection(event: WidgetCalendarEvent) {
  Column(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Text(text = "NEXT EVENT", style = SectionTitleStyle)
    Spacer(modifier = GlanceModifier.height(2.dp))
    Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Box(
        modifier = GlanceModifier
          .size(4.dp, 28.dp)
          .background(AccentPurple)
          .cornerRadius(2.dp),
      ) {}
      Spacer(modifier = GlanceModifier.width(8.dp))
      Column {
        Text(text = event.title, style = BodyStyle, maxLines = 1)
        Row {
          Text(text = event.time, style = TextStyle(color = AccentOrange, fontSize = 11.sp, fontWeight = FontWeight.Medium))
          if (event.location.isNotBlank()) {
            Text(text = "  ${event.location}", style = SecondaryStyle, maxLines = 1)
          }
        }
      }
    }
  }
}

// ── Tasks ──────────────────────────────────────────────────────────────────────

@Composable
private fun TasksSection(tasks: List<WidgetTask>) {
  Column(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Text(text = "TODAY'S TASKS", style = SectionTitleStyle)
    Spacer(modifier = GlanceModifier.height(2.dp))
    tasks.forEach { task ->
      Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = 1.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        val priorityColor = when (task.priority) {
          4 -> AccentRed
          3 -> AccentOrange
          2 -> AccentBlue
          else -> TextSecondary
        }
        Box(
          modifier = GlanceModifier.size(6.dp).background(priorityColor).cornerRadius(3.dp),
        ) {}
        Spacer(modifier = GlanceModifier.width(6.dp))
        Text(text = task.title, style = BodyStyle, maxLines = 1)
      }
    }
  }
}

// ── Emails ─────────────────────────────────────────────────────────────────────

@Composable
private fun EmailsSection(emails: List<WidgetEmail>) {
  Column(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Text(text = "INBOX", style = SectionTitleStyle)
    Spacer(modifier = GlanceModifier.height(2.dp))
    emails.forEach { email ->
      Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = 1.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        if (email.isUnread) {
          Box(modifier = GlanceModifier.size(5.dp).background(AccentBlue).cornerRadius(3.dp)) {}
          Spacer(modifier = GlanceModifier.width(4.dp))
        }
        Column(modifier = GlanceModifier.defaultWeight()) {
          Text(
            text = email.from,
            style = TextStyle(
              color = TextPrimary,
              fontSize = 11.sp,
              fontWeight = if (email.isUnread) FontWeight.Bold else FontWeight.Normal,
            ),
            maxLines = 1,
          )
          Text(text = email.subject, style = SecondaryStyle, maxLines = 1)
        }
      }
    }
  }
}

// ── Tickers ────────────────────────────────────────────────────────────────────

@Composable
private fun TickersSection(tickers: List<WidgetTicker>) {
  Column(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Text(text = "MARKETS", style = SectionTitleStyle)
    Spacer(modifier = GlanceModifier.height(3.dp))

    // Show tickers in rows of 3
    val chunked = tickers.chunked(3)
    chunked.forEach { row ->
      Row(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 1.dp)) {
        row.forEach { ticker ->
          Column(
            modifier = GlanceModifier.defaultWeight().padding(horizontal = 2.dp),
            horizontalAlignment = Alignment.Start,
          ) {
            Text(
              text = ticker.symbol,
              style = TextStyle(color = TextSecondary, fontSize = 9.sp, fontWeight = FontWeight.Medium),
            )
            Text(
              text = ticker.price,
              style = TextStyle(color = TextPrimary, fontSize = 11.sp),
            )
            Text(
              text = ticker.changePercent,
              style = TextStyle(
                color = if (ticker.isPositive) AccentGreen else AccentRed,
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
              ),
            )
          }
        }
        // Fill remaining slots if row has fewer than 3
        repeat(3 - row.size) {
          Spacer(modifier = GlanceModifier.defaultWeight())
        }
      }
    }
  }
}

// ── Headlines ──────────────────────────────────────────────────────────────────

@Composable
private fun HeadlinesSection(headlines: List<WidgetHeadline>) {
  Column(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Text(text = "NEWS", style = SectionTitleStyle)
    Spacer(modifier = GlanceModifier.height(2.dp))
    headlines.forEach { hl ->
      Column(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 1.dp)) {
        Text(text = hl.title, style = BodyStyle, maxLines = 2)
        if (hl.source.isNotBlank()) {
          Text(text = hl.source, style = SecondaryStyle)
        }
      }
    }
  }
}

// ── Weather ────────────────────────────────────────────────────────────────────

@Composable
private fun WeatherSection(summary: String) {
  Column(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Text(text = "WEATHER", style = SectionTitleStyle)
    Spacer(modifier = GlanceModifier.height(2.dp))
    Text(text = summary, style = BodyStyle, maxLines = 2)
  }
}

// ── Sports ─────────────────────────────────────────────────────────────────────

@Composable
private fun SportsSection(games: List<WidgetGame>) {
  Column(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Text(text = "SPORTS", style = SectionTitleStyle)
    Spacer(modifier = GlanceModifier.height(2.dp))
    games.forEach { game ->
      Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = 1.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        val leagueColor = when (game.league) {
          "NBA" -> AccentOrange
          "NFL" -> AccentGreen
          "MLB" -> AccentRed
          else -> AccentBlue
        }
        Text(
          text = game.league,
          style = TextStyle(color = leagueColor, fontSize = 9.sp, fontWeight = FontWeight.Bold),
        )
        Spacer(modifier = GlanceModifier.width(6.dp))
        Text(text = game.teams, style = BodyStyle, maxLines = 1, modifier = GlanceModifier.defaultWeight())
        Spacer(modifier = GlanceModifier.width(4.dp))
        val scoreColor = when (game.status) {
          "in", "halftime" -> AccentGreen
          "post" -> TextSecondary
          else -> AccentOrange
        }
        Text(
          text = game.score,
          style = TextStyle(color = scoreColor, fontSize = 11.sp, fontWeight = FontWeight.Medium),
        )
      }
    }
  }
}

// ── Utility ────────────────────────────────────────────────────────────────────

@Composable
private fun Divider() {
  Box(
    modifier = GlanceModifier
      .fillMaxWidth()
      .height(1.dp)
      .background(DividerColor),
  ) {}
}
