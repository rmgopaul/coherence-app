/**
 * FocusRail — Phase G companion to web `FocusModeRail.tsx`.
 *
 * Rendered under the BasquiatDashboardHero whenever AppPreferences.focusMode
 * is true. Shows the next calendar event + a live "T–Xm" countdown so the
 * user knows what's coming without unloading the rest of the dashboard
 * into their working memory.
 */
package com.coherence.healthconnect.ui.widgets

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.coherence.healthconnect.data.model.CalendarEvent
import com.coherence.healthconnect.ui.theme.BasquiatPalette
import com.coherence.healthconnect.ui.theme.BasquiatTypography
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

@Composable
fun FocusRail(
  nextEvent: CalendarEvent?,
  modifier: Modifier = Modifier,
) {
  // Tick once a minute so the countdown stays current without cooking
  // the battery — focus mode is meant to be quiet.
  var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
  LaunchedEffect(Unit) {
    while (isActive) {
      nowMs = System.currentTimeMillis()
      delay(30_000)
    }
  }

  if (nextEvent == null) {
    Surface(
      modifier = modifier.fillMaxWidth(),
      color = BasquiatPalette.Paper,
      shape = RoundedCornerShape(0.dp),
      border = BorderStroke(2.dp, BasquiatPalette.Rule),
    ) {
      Column(Modifier.padding(20.dp)) {
        Text(
          "NEXT",
          style = BasquiatTypography.Label,
          color = BasquiatPalette.Ink3,
        )
        Spacer(Modifier.height(8.dp))
        Text(
          "nothing scheduled.",
          fontFamily = BasquiatTypography.InstrumentSerif,
          fontStyle = FontStyle.Italic,
          fontSize = 18.sp,
          color = BasquiatPalette.Ink2,
        )
      }
    }
    return
  }

  val startMs = parseEventStartMs(nextEvent)
  val minsUntil = if (startMs != null) {
    ((startMs - nowMs).coerceAtLeast(0L) / 60_000L).toInt()
  } else {
    null
  }

  Surface(
    modifier = modifier.fillMaxWidth(),
    color = BasquiatPalette.Paper,
    shape = RoundedCornerShape(0.dp),
    border = BorderStroke(2.dp, BasquiatPalette.Rule),
  ) {
    Column(Modifier.padding(20.dp)) {
      Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Top,
      ) {
        Text(
          "NEXT",
          style = BasquiatTypography.Label,
          color = BasquiatPalette.Ink3,
        )
        Text(
          nextEvent.location?.takeIf { it.isNotBlank() } ?: "no room",
          style = BasquiatTypography.Label,
          color = BasquiatPalette.Ink3,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
      Spacer(Modifier.height(6.dp))
      Text(
        text = if (minsUntil != null) "T–${minsUntil}m" else "—",
        fontFamily = BasquiatTypography.ArchivoBlack,
        fontSize = 56.sp,
        letterSpacing = (-0.02).em,
        color = BasquiatPalette.Ink,
      )
      Spacer(Modifier.height(4.dp))
      Text(
        text = nextEvent.summary?.takeIf { it.isNotBlank() } ?: "(untitled)",
        fontFamily = BasquiatTypography.InstrumentSerif,
        fontStyle = FontStyle.Italic,
        fontSize = 22.sp,
        color = BasquiatPalette.Ink,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
      )
    }
  }
}

/**
 * Calendar events arrive as ISO-8601 with offset — `OffsetDateTime`
 * parses both `2026-04-20T15:30:00-05:00` and `2026-04-20T20:30:00Z`
 * cleanly. All-day events use `date` not `dateTime`; we anchor those
 * to local midnight (which is rarely the "next" event anyway, so any
 * imprecision here is harmless).
 */
private fun parseEventStartMs(event: CalendarEvent): Long? {
  val dt = event.start?.dateTime
  val date = event.start?.date
  return when {
    !dt.isNullOrBlank() -> try {
      OffsetDateTime.parse(dt).toInstant().toEpochMilli()
    } catch (_: DateTimeParseException) {
      null
    }
    !date.isNullOrBlank() -> try {
      val anchor = "${date}T00:00:00Z"
      OffsetDateTime.parse(anchor).toInstant().toEpochMilli()
    } catch (_: DateTimeParseException) {
      null
    }
    else -> null
  }
}
