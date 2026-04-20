package com.coherence.healthconnect.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.cornerRadius
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
import com.coherence.healthconnect.MainActivity
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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

// ── Basquiat palette ───────────────────────────────────────────────────────────
// Ink-mode tokens from productivity-hub/handoff/design-tokens.md
// §Color. Widget always renders in Ink (dark) because it sits on the
// home screen where launcher wallpaper might be anything.

private val Ink = ColorProvider(Color(0xFF0E0D0A))            // paper
private val InkBorder = ColorProvider(Color(0xFFF2EEDF))      // rule/border
private val TextPrimary = ColorProvider(Color(0xFFF2EEDF))    // ink
private val TextSecondary = ColorProvider(Color(0xFFC9C5B4))  // ink-2
private val TextTertiary = ColorProvider(Color(0xFF8F8B78))   // ink-3
private val AccentYellow = ColorProvider(Color(0xFFFFD84A))   // crown + highlight
private val AccentRed = ColorProvider(Color(0xFFFF5A47))      // alert
private val AccentBlue = ColorProvider(Color(0xFF6A8AFF))     // calendar
private val AccentGreen = ColorProvider(Color(0xFF66C266))    // up/positive
private val AccentOrange = ColorProvider(Color(0xFFFFB74D))   // upcoming game

// ── Styles ─────────────────────────────────────────────────────────────────────

private val SectionTitleStyle = TextStyle(
  color = TextTertiary,
  fontSize = 9.sp,
  fontWeight = FontWeight.Bold,
  // Glance has no letter-spacing API — compensate with all-caps labels.
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
      .background(Ink)
      .clickable(actionStartActivity<MainActivity>()),
    // No cornerRadius — the Basquiat shell is intentionally flat.
  ) {
    Column(
      modifier = GlanceModifier
        .fillMaxSize()
        .padding(12.dp),
    ) {
      // Header
      WidgetHeader(data.updatedAtMillis)

      // Next Calendar Event
      if (data.nextEvent != null) {
        NextEventSection(data.nextEvent)
      }

      // Tasks due today
      if (data.tasks.isNotEmpty()) {
        TasksSection(data.tasks)
      }

      // Emails
      if (data.emails.isNotEmpty()) {
        EmailsSection(data.emails)
      }

      // Market tickers
      if (data.tickers.isNotEmpty()) {
        TickersSection(data.tickers)
      }

      // Headlines
      if (data.headlines.isNotEmpty()) {
        HeadlinesSection(data.headlines)
      }

      // Weather
      if (data.weatherSummary != null) {
        WeatherSection(data.weatherSummary)
      }

      // Sports
      if (data.sports.isNotEmpty()) {
        SportsSection(data.sports)
      }

      // Error footer
      if (data.error != null) {
        Text(
          text = data.error,
          style = TextStyle(color = AccentRed, fontSize = 9.sp),
          modifier = GlanceModifier.padding(top = 4.dp),
        )
      }
    }
  }
}

// ── Header ─────────────────────────────────────────────────────────────────────

@Composable
private fun WidgetHeader(updatedAtMillis: Long) {
  Row(
    modifier = GlanceModifier
      .fillMaxWidth()
      .padding(bottom = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      text = "COHERENCE",
      style = TextStyle(
        color = AccentYellow,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
      ),
    )
    Spacer(modifier = GlanceModifier.defaultWeight())
    if (updatedAtMillis > 0) {
      val fmt = SimpleDateFormat("h:mm a", Locale.getDefault())
      Text(
        text = "UPDATED ${fmt.format(Date(updatedAtMillis)).uppercase(Locale.getDefault())}",
        style = TextStyle(
          color = TextTertiary,
          fontSize = 9.sp,
          fontWeight = FontWeight.Bold,
        ),
      )
    }
  }
}

// ── Next Event ─────────────────────────────────────────────────────────────────

@Composable
private fun NextEventSection(event: WidgetCalendarEvent) {
  Column(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Text(text = "NEXT UP", style = SectionTitleStyle)
    Spacer(modifier = GlanceModifier.height(2.dp))
    Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      // 3dp yellow rail — the Basquiat rule next to the headline.
      Box(
        modifier = GlanceModifier
          .size(3.dp, 30.dp)
          .background(AccentYellow),
      ) {}
      Spacer(modifier = GlanceModifier.width(8.dp))
      Column {
        Text(
          text = event.title,
          style = TextStyle(
            color = TextPrimary,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
          ),
          maxLines = 1,
        )
        Row {
          Text(
            text = event.time.uppercase(Locale.getDefault()),
            style = TextStyle(
              color = AccentYellow,
              fontSize = 10.sp,
              fontWeight = FontWeight.Bold,
            ),
          )
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
    Text(text = "UP NEXT", style = SectionTitleStyle)
    Spacer(modifier = GlanceModifier.height(2.dp))
    tasks.forEach { task ->
      Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = 1.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        val priorityColor = when (task.priority) {
          4 -> AccentRed
          3 -> AccentYellow
          else -> TextTertiary
        }
        // Square (not rounded) priority marker matches the
        // brutalist feel of the hero's stat tiles.
        Box(modifier = GlanceModifier.size(6.dp).background(priorityColor)) {}
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
          // Square yellow marker — echoes the task priority marker above.
          Box(modifier = GlanceModifier.size(5.dp).background(AccentYellow)) {}
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
