package com.coherence.healthconnect.ui.widgets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.CalendarEvent
import com.coherence.healthconnect.data.model.MarketDashboardResponse
import com.coherence.healthconnect.data.model.SamsungHealthDisplay
import com.coherence.healthconnect.data.model.TodoistTask
import com.coherence.healthconnect.data.model.WhoopSummary
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Morning briefing — one glanceable card at the very top of the
 * dashboard that answers the "what should I know right now" question
 * without scrolling. Time-aware: opens with "Good morning" / "Good
 * afternoon" / "Good evening" and surfaces evening-only CTAs (open
 * tonight's reflection, this week's review) once the work day winds
 * down.
 *
 * No new server endpoints. Reads the same state the rest of the
 * dashboard already has loaded — see DashboardScreen.kt for the
 * call sites.
 */
@Composable
fun MorningBriefingWidget(
  tasks: List<TodoistTask>,
  events: List<CalendarEvent>,
  whoop: WhoopSummary?,
  health: SamsungHealthDisplay?,
  market: MarketDashboardResponse?,
  hasReflectionToday: Boolean,
  onOpenReflection: () -> Unit,
  onOpenWeeklyReview: () -> Unit,
) {
  val now = remember_now()
  val today = remember_today()
  val greeting = greetingFor(now)
  val partOfDay = partOfDayFor(now)
  val isSunday = LocalDate.now().dayOfWeek.value == 7
  val showReflectionCta = partOfDay == PartOfDay.EVENING && !hasReflectionToday
  val showWeeklyReviewCta = isSunday

  val nextEvent = events
    .mapNotNull { event -> parseEventStart(event)?.let { event to it } }
    .filter { it.second >= now }
    .minByOrNull { it.second }

  val tasksDueToday = tasks.count { it.due?.date != null && it.due.date <= today }
  val recovery = whoop?.recoveryScore?.toInt()
  val energy = health?.energyScore
  val topHeadline = market?.headlines?.firstOrNull()?.title

  Card(
    modifier = Modifier.fillMaxWidth(),
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    shape = RoundedCornerShape(16.dp),
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .background(
          brush = Brush.horizontalGradient(
            colors = listOf(
              MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
              Color.Transparent,
            ),
          ),
        )
        .padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(
        text = greeting,
        style = MaterialTheme.typography.titleLarge,
        fontWeight = FontWeight.Bold,
      )

      val factLine = buildList {
        recovery?.let { add("Recovery $it%") }
        energy?.let { add("Energy $it") }
        if (tasksDueToday > 0) add("$tasksDueToday due today")
        nextEvent?.let { (event, startMillis) ->
          val mins = ((startMillis - now) / 60_000L).toInt()
          val title = event.summary?.take(28) ?: "Next event"
          val whenStr = when {
            mins < 60 -> "in ${mins.coerceAtLeast(1)} min"
            mins < 60 * 24 -> "${formatClock(startMillis)}"
            else -> "later"
          }
          add("Next: $title $whenStr")
        }
      }.joinToString(" · ")

      if (factLine.isNotBlank()) {
        Text(
          text = factLine,
          style = MaterialTheme.typography.bodyMedium,
          color = MaterialTheme.colorScheme.onSurface,
        )
      } else {
        Text(
          text = "Pull to refresh once data syncs.",
          style = MaterialTheme.typography.bodyMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }

      if (!topHeadline.isNullOrBlank()) {
        Text(
          text = "📰 $topHeadline",
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          maxLines = 2,
        )
      }

      if (showReflectionCta || showWeeklyReviewCta) {
        Spacer(modifier = Modifier.height(4.dp))
        Row(
          modifier = Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          if (showReflectionCta) {
            OutlinedButton(
              onClick = onOpenReflection,
              modifier = Modifier.weight(1f),
            ) {
              Text("Tonight's reflection")
            }
          }
          if (showWeeklyReviewCta) {
            OutlinedButton(
              onClick = onOpenWeeklyReview,
              modifier = Modifier.weight(1f),
            ) {
              Text("This week's review")
            }
          }
        }
      }
    }
  }
}

private enum class PartOfDay { MORNING, AFTERNOON, EVENING }

@Composable
private fun remember_now(): Long = androidx.compose.runtime.remember { System.currentTimeMillis() }

@Composable
private fun remember_today(): String = androidx.compose.runtime.remember {
  LocalDate.now().format(DateTimeFormatter.ISO_LOCAL_DATE)
}

private fun greetingFor(epochMillis: Long): String {
  val hour = LocalTime.now().hour
  val name = "Rhett"
  return when {
    hour < 5 -> "Late night, $name"
    hour < 12 -> "Good morning, $name"
    hour < 17 -> "Good afternoon, $name"
    else -> "Good evening, $name"
  }
}

private fun partOfDayFor(epochMillis: Long): PartOfDay {
  val hour = LocalTime.now().hour
  return when {
    hour < 12 -> PartOfDay.MORNING
    hour < 17 -> PartOfDay.AFTERNOON
    else -> PartOfDay.EVENING
  }
}

private fun parseEventStart(event: CalendarEvent): Long? {
  event.start?.dateTime?.let { iso ->
    return runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull()
  }
  event.start?.date?.let { date ->
    return runCatching {
      LocalDate.parse(date).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
    }.getOrNull()
  }
  return null
}

private fun formatClock(epochMillis: Long): String {
  val instant = Instant.ofEpochMilli(epochMillis)
  val zoned = instant.atZone(ZoneId.systemDefault())
  return zoned.format(DateTimeFormatter.ofPattern("h:mm a"))
}
