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
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
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

/**
 * Coherence King Widget — sized for the Galaxy Z Fold 7's inner
 * display.
 *
 * The original `CoherenceDashboardWidget` is sized for a regular phone
 * cell (3×3) and serializes everything into a single column. On the
 * unfolded Fold the same widget renders as a tiny 5%-of-screen
 * postage stamp surrounded by empty wallpaper. The King Widget is a
 * large-cell variant that occupies most of the inner display: a full-
 * width KoD hero across the top, then a 2-column grid of secondary
 * sections so steps / tasks / markets / headlines / inbox / sports
 * all fit without scrolling.
 *
 * It re-uses every other piece of the existing widget pipeline:
 *   - `WidgetData` / `WidgetDataStore` for the cached payload
 *   - `WidgetDataWorker` for the periodic + on-demand refresh
 *   - The same Basquiat palette / typography tokens
 *
 * The only widget-specific code is this Glance composable + its
 * receiver. Worker.save() ends with `updateAll()` calls for BOTH
 * widget classes, so a single worker tick repaints both surfaces.
 */
class CoherenceKingWidget : GlanceAppWidget() {

  // Exact size mode — Glance paints at whatever pixel size the
  // launcher allocates rather than a single fixed footprint. Required
  // for the resize handles to actually grow the rendered widget on
  // launchers like Samsung One UI that pass progressive size hints
  // during a drag. With SizeMode.Single the composable was committed
  // at a fixed footprint and the resize handle visually clipped
  // instead of expanding the canvas (the user's "stuck at half"
  // symptom on the Fold inner display).
  override val sizeMode: SizeMode = SizeMode.Exact

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val data = WidgetDataStore.load(context)
    provideContent {
      GlanceTheme {
        KingWidgetContent(data)
      }
    }
  }
}

// ── Basquiat palette (mirror of CoherenceDashboardWidget) ────────────────────

private val Ink = ColorProvider(Color(0xFF0E0D0A))
private val TextPrimary = ColorProvider(Color(0xFFF2EEDF))
private val TextSecondary = ColorProvider(Color(0xFFC9C5B4))
private val TextTertiary = ColorProvider(Color(0xFF8F8B78))
private val AccentYellow = ColorProvider(Color(0xFFFFD84A))
private val AccentRed = ColorProvider(Color(0xFFFF5A47))
private val AccentBlue = ColorProvider(Color(0xFF6A8AFF))
private val AccentGreen = ColorProvider(Color(0xFF66C266))
private val AccentOrange = ColorProvider(Color(0xFFFFB74D))

// Type scale is sized for a fullscreen Fold-inner widget. The widget
// occupies the entire ~750×740 dp canvas, so we lean into editorial
// proportions — the user reads it from a couple feet away on the
// home screen, not phone-arm distance.
private val SectionTitle = TextStyle(
  color = TextTertiary,
  fontSize = 14.sp,
  fontWeight = FontWeight.Bold,
)
private val Body = TextStyle(color = TextPrimary, fontSize = 17.sp)
private val Secondary = TextStyle(color = TextSecondary, fontSize = 14.sp)

// ── Layout ───────────────────────────────────────────────────────────────────

@Composable
private fun KingWidgetContent(data: WidgetData) {
  Box(
    modifier = GlanceModifier
      .fillMaxSize()
      .background(Ink)
      .clickable(actionStartActivity<MainActivity>()),
  ) {
    Column(
      modifier = GlanceModifier
        .fillMaxSize()
        .padding(horizontal = 28.dp, vertical = 24.dp),
    ) {
      Header(data.updatedAtMillis)
      Spacer(GlanceModifier.height(16.dp))

      // KoD hero — full width, oversized headline. The Fold's
      // landscape proportions give us room for a real editorial
      // splash here rather than the squished version on the phone.
      if (!data.kingOfDayTitle.isNullOrBlank()) {
        KingOfDayHero(
          title = data.kingOfDayTitle,
          reason = data.kingOfDayReason,
          source = data.kingOfDaySource,
        )
        Spacer(GlanceModifier.height(16.dp))
      }

      // Two-column body. Each column gets `defaultWeight()` so they
      // share width 50/50; sections are stacked top-to-bottom inside
      // each column. Empty sections collapse via the `if` gates.
      Row(
        modifier = GlanceModifier.fillMaxWidth().fillMaxHeight(),
      ) {
        Column(modifier = GlanceModifier.defaultWeight().padding(end = 10.dp)) {
          if (data.nextEvent != null) {
            NextEventSection(data.nextEvent)
            Spacer(GlanceModifier.height(12.dp))
          }
          if (data.tasks.isNotEmpty()) {
            TasksSection(data.tasks)
            Spacer(GlanceModifier.height(12.dp))
          }
          if (data.emails.isNotEmpty()) {
            EmailsSection(data.emails)
          }
        }
        Column(modifier = GlanceModifier.defaultWeight().padding(start = 10.dp)) {
          if (data.tickers.isNotEmpty()) {
            TickersSection(data.tickers)
            Spacer(GlanceModifier.height(12.dp))
          }
          if (data.headlines.isNotEmpty()) {
            HeadlinesSection(data.headlines)
            Spacer(GlanceModifier.height(12.dp))
          }
          if (data.sports.isNotEmpty()) {
            SportsSection(data.sports)
          }
        }
      }

      if (data.error != null) {
        Spacer(GlanceModifier.height(8.dp))
        Text(
          text = data.error,
          style = TextStyle(color = AccentRed, fontSize = 11.sp),
        )
      }
    }
  }
}

// ── Header ───────────────────────────────────────────────────────────────────

@Composable
private fun Header(updatedAtMillis: Long) {
  Row(
    modifier = GlanceModifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      text = "COHERENCE — KING",
      style = TextStyle(
        color = AccentYellow,
        fontSize = 22.sp,
        fontWeight = FontWeight.Bold,
      ),
    )
    Spacer(GlanceModifier.defaultWeight())
    if (updatedAtMillis > 0) {
      val fmt = SimpleDateFormat("h:mm a", Locale.getDefault())
      Text(
        text = "UPDATED ${fmt.format(Date(updatedAtMillis)).uppercase(Locale.getDefault())}",
        style = TextStyle(
          color = TextTertiary,
          fontSize = 14.sp,
          fontWeight = FontWeight.Bold,
        ),
      )
    }
  }
}

// ── KoD hero ─────────────────────────────────────────────────────────────────

@Composable
private fun KingOfDayHero(
  title: String,
  reason: String?,
  source: String?,
) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(text = "♛ KING OF THE DAY", style = SectionTitle)
      val sourceTag = when (source) {
        "manual" -> "PINNED"
        "ai" -> "AI"
        else -> null
      }
      if (sourceTag != null) {
        Spacer(GlanceModifier.width(10.dp))
        Text(
          text = sourceTag,
          style = TextStyle(
            color = AccentYellow,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
          ),
        )
      }
    }
    Spacer(GlanceModifier.height(8.dp))
    // Editorial headline at full Fold-inner-display proportions —
    // visible across the room, not just at phone-arm distance.
    Text(
      text = title,
      style = TextStyle(
        color = TextPrimary,
        fontSize = 48.sp,
        fontWeight = FontWeight.Bold,
      ),
      maxLines = 3,
    )
    if (!reason.isNullOrBlank()) {
      Spacer(GlanceModifier.height(8.dp))
      Text(
        text = reason,
        style = TextStyle(color = TextSecondary, fontSize = 18.sp),
        maxLines = 3,
      )
    }
  }
}

// ── Next event ───────────────────────────────────────────────────────────────

@Composable
private fun NextEventSection(event: WidgetCalendarEvent) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Text(text = "NEXT UP", style = SectionTitle)
    Spacer(GlanceModifier.height(4.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
      Box(
        modifier = GlanceModifier.size(5.dp, 44.dp).background(AccentYellow),
      ) {}
      Spacer(GlanceModifier.width(12.dp))
      Column {
        Text(
          text = event.title,
          style = TextStyle(
            color = TextPrimary,
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
          ),
          maxLines = 2,
        )
        Row {
          Text(
            text = event.time.uppercase(Locale.getDefault()),
            style = TextStyle(
              color = AccentYellow,
              fontSize = 16.sp,
              fontWeight = FontWeight.Bold,
            ),
          )
          if (event.location.isNotBlank()) {
            Text(
              text = "  ${event.location}",
              style = Secondary,
              maxLines = 1,
            )
          }
        }
      }
    }
  }
}

// ── Tasks ────────────────────────────────────────────────────────────────────

@Composable
private fun TasksSection(tasks: List<WidgetTask>) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Text(text = "UP NEXT", style = SectionTitle)
    Spacer(GlanceModifier.height(4.dp))
    // Take more tasks than the phone widget — Fold has the room.
    tasks.take(6).forEach { task ->
      Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        val priorityColor = when (task.priority) {
          4 -> AccentRed
          3 -> AccentYellow
          else -> TextTertiary
        }
        Box(modifier = GlanceModifier.size(8.dp).background(priorityColor)) {}
        Spacer(GlanceModifier.width(8.dp))
        Text(text = task.title, style = Body, maxLines = 1)
      }
    }
  }
}

// ── Emails ───────────────────────────────────────────────────────────────────

@Composable
private fun EmailsSection(emails: List<WidgetEmail>) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Text(text = "INBOX", style = SectionTitle)
    Spacer(GlanceModifier.height(4.dp))
    emails.take(4).forEach { email ->
      Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        if (email.isUnread) {
          Box(modifier = GlanceModifier.size(6.dp).background(AccentYellow)) {}
          Spacer(GlanceModifier.width(6.dp))
        }
        Column(modifier = GlanceModifier.defaultWeight()) {
          Text(
            text = email.from,
            style = TextStyle(
              color = TextPrimary,
              fontSize = 16.sp,
              fontWeight = if (email.isUnread) FontWeight.Bold else FontWeight.Normal,
            ),
            maxLines = 1,
          )
          Text(text = email.subject, style = Secondary, maxLines = 1)
        }
      }
    }
  }
}

// ── Tickers (3-column subgrid inside the right column) ───────────────────────

@Composable
private fun TickersSection(tickers: List<WidgetTicker>) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Text(text = "MARKETS", style = SectionTitle)
    Spacer(GlanceModifier.height(4.dp))
    tickers.chunked(3).forEach { row ->
      Row(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp)) {
        row.forEach { ticker ->
          Column(
            modifier = GlanceModifier.defaultWeight().padding(horizontal = 2.dp),
          ) {
            Text(
              text = ticker.symbol,
              style = TextStyle(
                color = TextSecondary,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
              ),
            )
            Text(
              text = ticker.price,
              style = TextStyle(color = TextPrimary, fontSize = 17.sp),
            )
            Text(
              text = ticker.changePercent,
              style = TextStyle(
                color = if (ticker.isPositive) AccentGreen else AccentRed,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
              ),
            )
          }
        }
        repeat(3 - row.size) { Spacer(GlanceModifier.defaultWeight()) }
      }
    }
  }
}

// ── Headlines ────────────────────────────────────────────────────────────────

@Composable
private fun HeadlinesSection(headlines: List<WidgetHeadline>) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Text(text = "NEWS", style = SectionTitle)
    Spacer(GlanceModifier.height(4.dp))
    headlines.take(5).forEach { hl ->
      Column(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(text = hl.title, style = Body, maxLines = 2)
        if (hl.source.isNotBlank()) {
          Text(text = hl.source, style = Secondary)
        }
      }
    }
  }
}

// ── Sports ───────────────────────────────────────────────────────────────────

@Composable
private fun SportsSection(games: List<WidgetGame>) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Text(text = "SPORTS", style = SectionTitle)
    Spacer(GlanceModifier.height(4.dp))
    games.take(4).forEach { game ->
      Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp),
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
          style = TextStyle(
            color = leagueColor,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
          ),
        )
        Spacer(GlanceModifier.width(10.dp))
        Text(
          text = game.teams,
          style = Body,
          maxLines = 1,
          modifier = GlanceModifier.defaultWeight(),
        )
        Spacer(GlanceModifier.width(8.dp))
        val scoreColor = when (game.status) {
          "in", "halftime" -> AccentGreen
          "post" -> TextSecondary
          else -> AccentOrange
        }
        Text(
          text = game.score,
          style = TextStyle(
            color = scoreColor,
            fontSize = 17.sp,
            fontWeight = FontWeight.Medium,
          ),
        )
      }
    }
  }
}
