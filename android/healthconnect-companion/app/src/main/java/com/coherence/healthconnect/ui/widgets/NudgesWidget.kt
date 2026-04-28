package com.coherence.healthconnect.ui.widgets

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.GmailMessage
import com.coherence.healthconnect.data.model.SamsungHealthDisplay
import com.coherence.healthconnect.data.model.TodoistTask
import com.coherence.healthconnect.data.model.WhoopSummary
import java.time.LocalTime

/**
 * One nudge — derived rule the user should act on now.
 *
 * `severity` drives the strip color. `onClick` is optional; null means
 * the nudge is informational only. Keep copy short — the dashboard is
 * already dense.
 */
data class Nudge(
  val id: String,
  val title: String,
  val body: String,
  val severity: NudgeSeverity,
  val onClick: (() -> Unit)? = null,
)

enum class NudgeSeverity { CRITICAL, WARNING, INFO }

/**
 * Smart nudges — client-side rules that derive 0-3 actionable cards
 * from the dashboard state already in memory. No new server endpoints,
 * no cron — this is the lightweight version of the full notifications
 * system that's still on the roadmap.
 *
 * The rules:
 *   • Recovery < 45% → CRITICAL "protect today"
 *   • Energy score ≤ 50 → WARNING "low energy day"
 *   • >= 10 unread important emails → WARNING "triage"
 *   • Evening (≥ 20h) and no reflection saved → INFO "close the day"
 *
 * Each rule is independent. The widget renders nothing when no rules
 * fire, which is the desired behavior for a healthy day.
 */
@Composable
fun NudgesWidget(
  whoop: WhoopSummary?,
  health: SamsungHealthDisplay?,
  emails: List<GmailMessage>,
  tasks: List<TodoistTask>,
  hasReflectionToday: Boolean,
  onOpenReflection: () -> Unit,
  onOpenTasks: () -> Unit,
  onOpenEmail: () -> Unit,
) {
  val nudges = remember_nudges(
    whoop = whoop,
    health = health,
    emails = emails,
    tasks = tasks,
    hasReflectionToday = hasReflectionToday,
    onOpenReflection = onOpenReflection,
    onOpenTasks = onOpenTasks,
    onOpenEmail = onOpenEmail,
  )

  if (nudges.isEmpty()) return

  Column(
    modifier = Modifier.fillMaxWidth(),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    nudges.take(3).forEach { nudge ->
      NudgeCard(nudge)
    }
  }
}

@Composable
private fun remember_nudges(
  whoop: WhoopSummary?,
  health: SamsungHealthDisplay?,
  emails: List<GmailMessage>,
  tasks: List<TodoistTask>,
  hasReflectionToday: Boolean,
  onOpenReflection: () -> Unit,
  onOpenTasks: () -> Unit,
  onOpenEmail: () -> Unit,
): List<Nudge> {
  val list = mutableListOf<Nudge>()

  whoop?.recoveryScore?.let { recovery ->
    if (recovery < 45.0) {
      list += Nudge(
        id = "recovery-low",
        title = "Recovery is ${recovery.toInt()}%",
        body = "Light day. Protect sleep tonight; defer heavy lifts.",
        severity = NudgeSeverity.CRITICAL,
        onClick = null,
      )
    }
  }

  health?.energyScore?.let { energy ->
    if (energy <= 50 && (whoop?.recoveryScore ?: 100.0) >= 45.0) {
      list += Nudge(
        id = "energy-low",
        title = "Samsung energy at $energy",
        body = "Hydrate, walk, snack. Schedule your hardest task for after lunch.",
        severity = NudgeSeverity.WARNING,
        onClick = null,
      )
    }
  }

  val unread = emails.count { it.isUnread }
  if (unread >= 10) {
    list += Nudge(
      id = "email-triage",
      title = "$unread unread emails",
      body = "Block 15 minutes for triage — open Gmail.",
      severity = NudgeSeverity.WARNING,
      onClick = onOpenEmail,
    )
  }

  val hour = LocalTime.now().hour
  if (hour >= 20 && !hasReflectionToday) {
    list += Nudge(
      id = "reflection-pending",
      title = "Close the day",
      body = "Two minutes to log energy + tomorrow's one thing.",
      severity = NudgeSeverity.INFO,
      onClick = onOpenReflection,
    )
  }

  // Mid-morning, no plan, lots due → encourage focus pick.
  val tasksDueToday = tasks.count {
    val due = it.due?.date
    due != null && due <= java.time.LocalDate.now().toString()
  }
  if (hour in 9..11 && tasksDueToday >= 6) {
    list += Nudge(
      id = "task-focus",
      title = "$tasksDueToday tasks due today",
      body = "Pick three. Defer or split the rest.",
      severity = NudgeSeverity.WARNING,
      onClick = onOpenTasks,
    )
  }

  return list
}

@Composable
private fun NudgeCard(nudge: Nudge) {
  val (stripColor, containerColor) = when (nudge.severity) {
    NudgeSeverity.CRITICAL -> Color(0xFFE53935) to MaterialTheme.colorScheme.errorContainer
    NudgeSeverity.WARNING -> Color(0xFFFFAB00) to MaterialTheme.colorScheme.tertiaryContainer
    NudgeSeverity.INFO -> MaterialTheme.colorScheme.primary to MaterialTheme.colorScheme.surfaceVariant
  }

  Card(
    modifier = Modifier
      .fillMaxWidth()
      .let { if (nudge.onClick != null) it.clickable { nudge.onClick.invoke() } else it },
    colors = CardDefaults.cardColors(containerColor = containerColor),
    shape = RoundedCornerShape(12.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Box(
        modifier = Modifier
          .width(4.dp)
          .height(56.dp)
          .background(stripColor),
      )
      Column(
        modifier = Modifier
          .padding(horizontal = 12.dp, vertical = 12.dp)
          .fillMaxWidth(),
      ) {
        Text(
          text = nudge.title,
          style = MaterialTheme.typography.bodyMedium,
          fontWeight = FontWeight.Bold,
        )
        Text(
          text = nudge.body,
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }
  }
}
