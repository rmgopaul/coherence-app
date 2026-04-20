/**
 * FocusModeToggle — small bordered text button mirroring the web
 * `FOCUS [ ]` / `FOCUS [■]` toggle in the masthead. Sits at the top of
 * the dashboard scroll, right-aligned, so the user can collapse the
 * dashboard to the hero + FocusRail without leaving the screen.
 *
 * Per CLAUDE.md / handoff/focus-mode.md: brutalist box, mono font,
 * inverted on hover/active. No animation entering focus mode — page
 * snaps; the transition would break the premise.
 */
package com.coherence.healthconnect.ui.widgets

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import com.coherence.healthconnect.ui.theme.BasquiatPalette
import com.coherence.healthconnect.ui.theme.BasquiatTypography

@Composable
fun FocusModeToggle(
  focusMode: Boolean,
  onToggle: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Row(
    modifier = modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.End,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Surface(
      onClick = onToggle,
      shape = RoundedCornerShape(0.dp),
      border = BorderStroke(2.dp, BasquiatPalette.Rule),
      color = if (focusMode) BasquiatPalette.Ink else BasquiatPalette.Paper,
    ) {
      Row(
        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          text = "FOCUS",
          style = BasquiatTypography.Label.copy(fontSize = 11.sp),
          color = if (focusMode) BasquiatPalette.Paper else BasquiatPalette.Ink,
        )
        Text(
          text = if (focusMode) "  [■]" else "  [ ]",
          style = BasquiatTypography.Label.copy(fontSize = 11.sp),
          color = if (focusMode) BasquiatPalette.Yellow else BasquiatPalette.Ink2,
        )
      }
    }
  }
}
