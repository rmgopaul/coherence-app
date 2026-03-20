package com.coherence.samsunghealth.ui.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.RestartAlt
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlin.math.max

enum class TimerPhase { IDLE, FOCUS, BREAK }

@Composable
fun FocusTimerWidget(
  focusDurationMinutes: Int = 25,
) {
  val safeFocusDurationMinutes = focusDurationMinutes.coerceIn(10, 180)
  val focusDurationMs = safeFocusDurationMinutes * 60 * 1000L
  val breakDurationMs = max(5, safeFocusDurationMinutes / 5) * 60 * 1000L
  var phase by remember { mutableStateOf(TimerPhase.IDLE) }
  var remainingMs by remember(focusDurationMs) { mutableLongStateOf(focusDurationMs) }
  var isRunning by remember { mutableStateOf(false) }

  LaunchedEffect(isRunning) {
    while (isRunning && remainingMs > 0) {
      delay(1000)
      remainingMs -= 1000
    }
    if (remainingMs <= 0 && isRunning) {
      isRunning = false
      // Auto-transition
      when (phase) {
        TimerPhase.FOCUS -> {
          phase = TimerPhase.BREAK
          remainingMs = breakDurationMs
        }
        TimerPhase.BREAK -> {
          phase = TimerPhase.IDLE
          remainingMs = focusDurationMs
        }
        TimerPhase.IDLE -> {}
      }
    }
  }

  WidgetShell(title = "Focus Timer", icon = Icons.Default.Timer, category = WidgetCategory.PRODUCTIVITY) {
    Column(
      modifier = Modifier.fillMaxWidth(),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      // Phase label
      if (phase != TimerPhase.IDLE) {
        Text(
          text = if (phase == TimerPhase.FOCUS) "Focus" else "Break",
          style = MaterialTheme.typography.labelLarge,
          color = if (phase == TimerPhase.FOCUS) MaterialTheme.colorScheme.primary
          else MaterialTheme.colorScheme.tertiary,
          modifier = Modifier.padding(bottom = 4.dp),
        )
      }

      // Time display
      val minutes = (remainingMs / 60000).toInt()
      val seconds = ((remainingMs % 60000) / 1000).toInt()
      Text(
        text = "%02d:%02d".format(minutes, seconds),
        fontSize = 48.sp,
        fontWeight = FontWeight.Light,
        letterSpacing = 4.sp,
      )

      // Controls
      Row(
        modifier = Modifier.padding(top = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        when {
          phase == TimerPhase.IDLE -> {
            FilledTonalButton(onClick = {
              phase = TimerPhase.FOCUS
              remainingMs = focusDurationMs
              isRunning = true
            }) {
              Icon(Icons.Default.PlayArrow, contentDescription = null)
              Text("Start Focus", modifier = Modifier.padding(start = 4.dp))
            }
          }
          else -> {
            IconButton(onClick = { isRunning = !isRunning }) {
              Icon(
                if (isRunning) Icons.Default.Pause else Icons.Default.PlayArrow,
                contentDescription = if (isRunning) "Pause" else "Resume",
              )
            }
            IconButton(onClick = {
              phase = TimerPhase.IDLE
              remainingMs = focusDurationMs
              isRunning = false
            }) {
              Icon(Icons.Default.RestartAlt, contentDescription = "Reset")
            }
          }
        }
      }
    }
  }
}
