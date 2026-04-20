package com.coherence.samsunghealth.ui.widgets

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import com.coherence.samsunghealth.ui.theme.BasquiatColors
import com.coherence.samsunghealth.ui.theme.BasquiatTypography
import androidx.compose.material3.Text
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Basquiat Dashboard Hero — Phase E.
 *
 * Editorial broadsheet layout, replacing the gradient-card
 * `DashboardHero`. Same HeroStats signature, so swapping at call
 * sites is a single-line change:
 *
 *   BasquiatDashboardHero(stats = heroStats)     // new
 *   // vs
 *   DashboardHero(stats = heroStats)             // legacy
 *
 * Ships alongside the legacy hero — nothing is replaced until the
 * caller opts in. The design direction lives in:
 *
 *   productivity-hub/handoff/android-spec.md
 *   productivity-hub/handoff/design-tokens.md
 *
 * Zero rounded corners, 2dp ink border, offset drop-shadow, hand-
 * drawn yellow crown SVG inline. Body uses the new Paper/Ink
 * palette; `isSystemInDarkTheme()` flips to Ink mode.
 */
@Composable
fun BasquiatDashboardHero(
  stats: HeroStats,
  modifier: Modifier = Modifier,
) {
  val darkTheme = isSystemInDarkTheme()
  val colors = remember(darkTheme) { BasquiatColors.forMode(darkTheme) }

  val hour = remember { LocalTime.now().hour }
  val greeting = remember(hour) {
    when (hour) {
      in 5..11 -> "morning"
      in 12..17 -> "afternoon"
      else -> "evening"
    }
  }
  val dateText = remember {
    LocalDate.now()
      .format(DateTimeFormatter.ofPattern("EEE · MMM d · yyyy", Locale.US))
      .uppercase(Locale.US)
  }

  val headline = remember(stats) { deriveHeadline(stats) }
  val annotation = remember(stats) { deriveAnnotation(stats) }

  // Brutalist card shell — no rounded corners, 2dp ink border,
  // flat 6dp offset shadow imitated via a stacked Box.
  Box(
    modifier = modifier.fillMaxWidth(),
  ) {
    // Offset shadow plate (flat, no blur).
    Box(
      modifier = Modifier
        .fillMaxWidth()
        .padding(start = 6.dp, top = 6.dp)
        .background(colors.ink),
    ) {
      Spacer(Modifier.height(0.dp))
    }

    Column(
      modifier = Modifier
        .fillMaxWidth()
        .clip(RectangleShape)
        .background(if (darkTheme) colors.paper2 else colors.ink)
        .border(2.dp, colors.ink)
        .padding(20.dp),
    ) {
      // Top row: date + crown
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Top,
      ) {
        Column(modifier = Modifier.weight(1f)) {
          Text(
            text = dateText,
            style = BasquiatTypography.Label,
            color = if (darkTheme) colors.ink3 else colors.paper,
          )
          Spacer(Modifier.height(4.dp))
          Text(
            text = "$greeting —",
            style = BasquiatTypography.Subhead,
            color = colors.yellow,
          )
        }
        Crown(
          tint = colors.yellow,
          modifier = Modifier.size(width = 96.dp, height = 56.dp),
        )
      }

      Spacer(Modifier.height(16.dp))

      // Headline — the one thing, with yellow highlighter behind it.
      Text(
        text = buildAnnotatedString {
          withStyle(
            SpanStyle(
              background = colors.highlightYellow,
              color = colors.ink,
            )
          ) {
            append(headline)
          }
        },
        style = BasquiatTypography.Hero,
        color = if (darkTheme) colors.ink else colors.paper,
      )

      Spacer(Modifier.height(4.dp))
      Text(
        text = annotation,
        style = BasquiatTypography.Kicker,
        color = colors.red,
      )

      Spacer(Modifier.height(20.dp))

      // Stat row: DUE · EVENTS · RECOVERY · STREAK
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
      ) {
        BasquiatStat(
          label = "DUE",
          value = stats.tasksDueToday.toString(),
          colors = colors,
          onDark = !darkTheme,
        )
        BasquiatStat(
          label = "EVENTS",
          value = stats.eventsToday.toString(),
          colors = colors,
          onDark = !darkTheme,
        )
        BasquiatStat(
          label = "RECOVERY",
          value = stats.recoveryPercent?.let { "$it" } ?: "—",
          colors = colors,
          onDark = !darkTheme,
        )
        BasquiatStat(
          label = "STREAK",
          value = stats.habitStreak?.toString() ?: "—",
          colors = colors,
          onDark = !darkTheme,
        )
      }
    }
  }
}

@Composable
private fun BasquiatStat(
  label: String,
  value: String,
  colors: BasquiatColors,
  onDark: Boolean,
) {
  Column(horizontalAlignment = Alignment.Start) {
    Text(
      text = label,
      style = BasquiatTypography.Label,
      color = if (onDark) colors.ink3 else colors.paper.copy(alpha = 0.6f),
    )
    Spacer(Modifier.height(6.dp))
    Text(
      text = value,
      style = BasquiatTypography.StatBig,
      color = if (onDark) colors.ink else colors.paper,
    )
  }
}

/**
 * Hand-drawn three-spike Basquiat crown. Inline Canvas rather than a
 * drawable so the stroke colour can react to theme without a resource
 * round-trip.
 */
@Composable
private fun Crown(tint: Color, modifier: Modifier = Modifier) {
  Canvas(modifier = modifier) {
    drawBasquiatCrown(tint)
  }
}

private fun DrawScope.drawBasquiatCrown(tint: Color) {
  val w = size.width
  val h = size.height
  // Path points mirror the web KingOfTheDayHero crown viewBox 240x140.
  val points = listOf(
    Offset(0.058f * w, 0.871f * h),   // 14, 122
    Offset(0.192f * w, 0.171f * h),   // 46, 24
    Offset(0.358f * w, 0.686f * h),   // 86, 96
    Offset(0.500f * w, 0.086f * h),   // 120, 12
    Offset(0.642f * w, 0.686f * h),   // 154, 96
    Offset(0.817f * w, 0.171f * h),   // 196, 24
    Offset(0.942f * w, 0.871f * h),   // 226, 122
  )
  val path = Path().apply {
    moveTo(points.first().x, points.first().y)
    for (i in 1 until points.size) lineTo(points[i].x, points[i].y)
  }
  drawPath(
    path = path,
    color = tint,
    style = Stroke(
      width = 6f,
      cap = StrokeCap.Round,
      join = StrokeJoin.Round,
    ),
  )
  // Baseline rule beneath the spikes.
  drawPath(
    path = Path().apply {
      moveTo(0.042f * w, 0.914f * h)
      lineTo(0.958f * w, 0.914f * h)
    },
    color = tint,
    style = Stroke(width = 5f, cap = StrokeCap.Round),
  )
}

/**
 * Editorial headline derived from the hero stats. Mirrors the
 * web hero's `deriveHeadline` fallback but Android-flavoured.
 */
private fun deriveHeadline(stats: HeroStats): String {
  return when {
    stats.tasksDueToday >= 5 -> "TODAY IS A LIST"
    stats.tasksDueToday > 0 -> "SHIP ONE THING"
    stats.eventsToday > 0 -> "SHOW UP SHARP"
    else -> "A CLEAN SLATE"
  }
}

private fun deriveAnnotation(stats: HeroStats): String {
  return when {
    stats.tasksDueToday >= 5 -> "${stats.tasksDueToday} due — pick the heaviest first"
    stats.tasksDueToday > 0 -> "${stats.tasksDueToday} due today"
    stats.eventsToday > 0 -> "${stats.eventsToday} on the calendar"
    else -> "nothing burning."
  }
}

@Preview(showBackground = true, widthDp = 400)
@Composable
private fun BasquiatDashboardHeroPreview() {
  BasquiatDashboardHero(
    stats = HeroStats(
      tasksDueToday = 3,
      eventsToday = 2,
      recoveryPercent = 72,
      habitStreak = 11,
    ),
  )
}
