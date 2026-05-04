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
import androidx.glance.appwidget.action.actionRunCallback
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
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.coherence.healthconnect.MainActivity

/**
 * Loop-style habits widget. Renders each active habit as a tappable
 * tile in a 2-column grid. Tapping a tile fires [ToggleHabitAction]
 * which toggles completion via the tRPC `habits.setCompletion`
 * mutation and repaints. Completed tiles fill with the habit's color;
 * incomplete tiles render as a dim outline. Each tile shows the habit
 * name and a flame + current streak count.
 *
 * Layout choices:
 * - 2-column grid (Glance has no LazyVerticalGrid, so we chunk rows
 *   manually). Two columns reads well at the default 4×2 widget size
 *   and still works if the user resizes wider.
 * - Tile background colors render via the per-habit Tailwind palette
 *   from `HabitsScreen.kt`, mirrored here so the widget and the
 *   in-app habits screen stay visually consistent.
 * - The whole widget background is intentionally tappable (opens the
 *   app to the habits screen) using the same Ink shell as the
 *   other Coherence widgets — the per-tile clickable() takes
 *   precedence inside its own bounds.
 */
class CoherenceHabitsWidget : GlanceAppWidget() {

  override val sizeMode: SizeMode = SizeMode.Single

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val data = WidgetDataStore.load(context)
    provideContent {
      GlanceTheme {
        HabitsContent(data.habits)
      }
    }
  }
}

// ── Palette ──────────────────────────────────────────────────────────────────
// Ink shell mirrors the rest of the Coherence widget family. Per-tile
// completion colors come from `habitFillColor` below.

private val Ink = ColorProvider(Color(0xFF0E0D0A))
private val TextSecondary = ColorProvider(Color(0xFFC9C5B4))
private val TextTertiary = ColorProvider(Color(0xFF8F8B78))
private val AccentYellow = ColorProvider(Color(0xFFFFD84A))

// Tailwind palette — mirrors `HabitsScreen.habitColor` so the widget
// and the in-app habits view share a single visual language.
private fun habitFillColor(color: String): Color = when (color) {
  "red" -> Color(0xFFEF4444)
  "orange" -> Color(0xFFF97316)
  "amber" -> Color(0xFFF59E0B)
  "yellow" -> Color(0xFFEAB308)
  "lime" -> Color(0xFF84CC16)
  "green" -> Color(0xFF22C55E)
  "emerald" -> Color(0xFF10B981)
  "teal" -> Color(0xFF14B8A6)
  "cyan" -> Color(0xFF06B6D4)
  "sky" -> Color(0xFF0EA5E9)
  "blue" -> Color(0xFF3B82F6)
  "indigo" -> Color(0xFF6366F1)
  "violet" -> Color(0xFF8B5CF6)
  "purple" -> Color(0xFFA855F7)
  "fuchsia" -> Color(0xFFD946EF)
  "pink" -> Color(0xFFEC4899)
  "rose" -> Color(0xFFF43F5E)
  else -> Color(0xFF64748B) // slate
}

// ── Layout ───────────────────────────────────────────────────────────────────

@Composable
private fun HabitsContent(habits: List<WidgetHabit>) {
  Box(
    modifier = GlanceModifier
      .fillMaxSize()
      .background(Ink),
  ) {
    Column(
      modifier = GlanceModifier
        .fillMaxSize()
        .padding(10.dp),
    ) {
      Header()
      Spacer(GlanceModifier.height(8.dp))
      if (habits.isEmpty()) {
        EmptyState()
      } else {
        HabitsGrid(habits)
      }
    }
  }
}

@Composable
private fun Header() {
  Row(
    modifier = GlanceModifier
      .fillMaxWidth()
      .clickable(actionStartActivity<MainActivity>()),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      text = "HABITS",
      style = TextStyle(
        color = AccentYellow,
        fontSize = 12.sp,
        fontWeight = FontWeight.Bold,
      ),
    )
    Spacer(GlanceModifier.defaultWeight())
    Text(
      text = "TAP TO LOG",
      style = TextStyle(
        color = TextTertiary,
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
      ),
    )
  }
}

@Composable
private fun EmptyState() {
  Column(
    modifier = GlanceModifier
      .fillMaxSize()
      .clickable(actionStartActivity<MainActivity>()),
    verticalAlignment = Alignment.CenterVertically,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      text = "No habits yet",
      style = TextStyle(
        color = TextSecondary,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
      ),
    )
    Spacer(GlanceModifier.height(4.dp))
    Text(
      text = "Open Coherence to add some",
      style = TextStyle(color = TextTertiary, fontSize = 11.sp),
    )
  }
}

/**
 * Glance has no LazyVerticalGrid; chunk into rows of 2 so the layout
 * still looks like a grid at the default placement size. The user
 * can resize wider and it'll still read because every tile takes
 * `defaultWeight()` within its row.
 */
@Composable
private fun HabitsGrid(habits: List<WidgetHabit>) {
  // Cap at 8 tiles (4 rows × 2 cols) — anything beyond would overflow
  // the typical home-screen widget cell budget. The full habit list
  // remains accessible by tapping the header to open the app.
  val visible = habits.take(8)
  val rows = visible.chunked(2)
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    rows.forEachIndexed { index, row ->
      Row(modifier = GlanceModifier.fillMaxWidth()) {
        row.forEach { habit ->
          Box(
            modifier = GlanceModifier
              .defaultWeight()
              .padding(3.dp),
          ) {
            HabitTile(habit)
          }
        }
        // Pad incomplete rows so the surviving tile keeps its width.
        if (row.size < 2) {
          Spacer(modifier = GlanceModifier.defaultWeight())
        }
      }
      if (index < rows.lastIndex) {
        Spacer(GlanceModifier.height(0.dp))
      }
    }
  }
}

@Composable
private fun HabitTile(habit: WidgetHabit) {
  val fill = habitFillColor(habit.color)
  // Completed = saturated fill; incomplete = dim panel with a subtle
  // tint so the user can still tell the habits apart at rest.
  val bg = if (habit.completed) fill else Color(0xFF1A1814)
  // Text needs to contrast both states. On the saturated fill we use
  // ink-paper; on the dim panel we keep the bone-white primary.
  val titleColor = if (habit.completed) Color(0xFF0E0D0A) else Color(0xFFF2EEDF)
  val secondaryColor = if (habit.completed) Color(0xFF0E0D0A) else fill

  Column(
    modifier = GlanceModifier
      .fillMaxWidth()
      .height(64.dp)
      .background(ColorProvider(bg))
      .padding(horizontal = 8.dp, vertical = 6.dp)
      .clickable(
        actionRunCallback<ToggleHabitAction>(
          parameters = ToggleHabitAction.parameters(
            habitId = habit.id,
            currentlyCompleted = habit.completed,
          ),
        ),
      ),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      text = habit.name,
      style = TextStyle(
        color = ColorProvider(titleColor),
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
      ),
      maxLines = 2,
    )
    Spacer(GlanceModifier.height(2.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(
        text = if (habit.streak > 0) "🔥" else "·",
        style = TextStyle(
          color = ColorProvider(secondaryColor),
          fontSize = 11.sp,
        ),
      )
      Spacer(GlanceModifier.width(3.dp))
      Text(
        text = if (habit.streak > 0) "${habit.streak}d" else "—",
        style = TextStyle(
          color = ColorProvider(secondaryColor),
          fontSize = 11.sp,
          fontWeight = FontWeight.Bold,
        ),
      )
    }
  }
}
