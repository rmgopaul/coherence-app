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
 * Left half of the King widget pair.
 *
 * Background:
 * Samsung One UI's inner-display launcher caps a SINGLE widget at
 * ~7×9 cells = ~451×776 dp, which is roughly half the width of the
 * inner display. Trying to grow past that with bigger min/max dims
 * was futile — the launcher silently locks at the grid limit.
 *
 * Workaround: TWO widgets. Each is sized to that ~half-screen cap;
 * placed side-by-side they form a contiguous "full screen" King
 * experience that occupies the entire inner display canvas.
 *
 * This (Left) widget owns:
 *   - Header strip ("COHERENCE — KING")
 *   - KoD hero
 *   - Next calendar event
 *   - Tasks (top 6)
 *   - Inbox (top 4)
 *
 * The Right widget (CoherenceKingRightWidget) owns markets,
 * headlines, and sports.
 *
 * Both reuse the same WidgetData / WidgetDataStore / WidgetDataWorker
 * pipeline. The worker's doWork() calls updateAll() against every
 * widget class so a single tick repaints all of them.
 */
class CoherenceKingLeftWidget : GlanceAppWidget() {

  override val sizeMode: SizeMode = SizeMode.Single

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val data = WidgetDataStore.load(context)
    provideContent {
      GlanceTheme {
        LeftContent(data)
      }
    }
  }
}

// ── Palette + type (mirrors CoherenceKingWidget) ─────────────────────────────

private val Ink = ColorProvider(Color(0xFF0E0D0A))
private val TextPrimary = ColorProvider(Color(0xFFF2EEDF))
private val TextSecondary = ColorProvider(Color(0xFFC9C5B4))
private val TextTertiary = ColorProvider(Color(0xFF8F8B78))
private val AccentYellow = ColorProvider(Color(0xFFFFD84A))
private val AccentRed = ColorProvider(Color(0xFFFF5A47))

private val SectionTitle = TextStyle(
  color = TextTertiary,
  fontSize = 12.sp,
  fontWeight = FontWeight.Bold,
)
private val Body = TextStyle(color = TextPrimary, fontSize = 14.sp)
private val Secondary = TextStyle(color = TextSecondary, fontSize = 12.sp)

// ── Layout ───────────────────────────────────────────────────────────────────

@Composable
private fun LeftContent(data: WidgetData) {
  Box(
    modifier = GlanceModifier
      .fillMaxSize()
      .background(Ink)
      .clickable(actionStartActivity<MainActivity>()),
  ) {
    Column(
      modifier = GlanceModifier
        .fillMaxSize()
        .padding(horizontal = 18.dp, vertical = 16.dp),
    ) {
      Header(data.updatedAtMillis)
      Spacer(GlanceModifier.height(10.dp))

      if (!data.kingOfDayTitle.isNullOrBlank()) {
        KingOfDayHero(
          title = data.kingOfDayTitle,
          reason = data.kingOfDayReason,
          source = data.kingOfDaySource,
        )
        Spacer(GlanceModifier.height(12.dp))
      }

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

      if (data.error != null) {
        Spacer(GlanceModifier.height(8.dp))
        Text(text = data.error, style = TextStyle(color = AccentRed, fontSize = 11.sp))
      }
    }
  }
}

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
        fontSize = 16.sp,
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
          fontSize = 10.sp,
          fontWeight = FontWeight.Bold,
        ),
      )
    }
  }
}

@Composable
private fun KingOfDayHero(
  title: String,
  reason: String?,
  source: String?,
) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(text = "♛ KING OF THE DAY", style = SectionTitle)
      val tag = when (source) {
        "manual" -> "PINNED"
        "ai" -> "AI"
        else -> null
      }
      if (tag != null) {
        Spacer(GlanceModifier.width(8.dp))
        Text(
          text = tag,
          style = TextStyle(
            color = AccentYellow,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
          ),
        )
      }
    }
    Spacer(GlanceModifier.height(6.dp))
    Text(
      text = title,
      style = TextStyle(
        color = TextPrimary,
        fontSize = 28.sp,
        fontWeight = FontWeight.Bold,
      ),
      maxLines = 4,
    )
    if (!reason.isNullOrBlank()) {
      Spacer(GlanceModifier.height(6.dp))
      Text(
        text = reason,
        style = TextStyle(color = TextSecondary, fontSize = 14.sp),
        maxLines = 3,
      )
    }
  }
}

@Composable
private fun NextEventSection(event: WidgetCalendarEvent) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Text(text = "NEXT UP", style = SectionTitle)
    Spacer(GlanceModifier.height(4.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
      Box(
        modifier = GlanceModifier.size(4.dp, 36.dp).background(AccentYellow),
      ) {}
      Spacer(GlanceModifier.width(10.dp))
      Column {
        Text(
          text = event.title,
          style = TextStyle(
            color = TextPrimary,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
          ),
          maxLines = 2,
        )
        Row {
          Text(
            text = event.time.uppercase(Locale.getDefault()),
            style = TextStyle(
              color = AccentYellow,
              fontSize = 12.sp,
              fontWeight = FontWeight.Bold,
            ),
          )
          if (event.location.isNotBlank()) {
            Text(text = "  ${event.location}", style = Secondary, maxLines = 1)
          }
        }
      }
    }
  }
}

@Composable
private fun TasksSection(tasks: List<WidgetTask>) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Text(text = "UP NEXT", style = SectionTitle)
    Spacer(GlanceModifier.height(4.dp))
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
        Box(modifier = GlanceModifier.size(6.dp).background(priorityColor)) {}
        Spacer(GlanceModifier.width(6.dp))
        Text(text = task.title, style = Body, maxLines = 1)
      }
    }
  }
}

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
          Box(modifier = GlanceModifier.size(5.dp).background(AccentYellow)) {}
          Spacer(GlanceModifier.width(5.dp))
        }
        Column(modifier = GlanceModifier.defaultWeight()) {
          Text(
            text = email.from,
            style = TextStyle(
              color = TextPrimary,
              fontSize = 13.sp,
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
