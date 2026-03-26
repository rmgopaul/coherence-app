package com.coherence.samsunghealth.ui.widgets

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.coherence.samsunghealth.data.model.GameInfo
import com.coherence.samsunghealth.data.model.SportsResponse

/* ------------------------------------------------------------------ */
/*  Colors                                                              */
/* ------------------------------------------------------------------ */

private val LiveRed = Color(0xFFDC2626)
private val LiveBgLight = Color(0x14DC2626)
private val LiveBorderLight = Color(0x40DC2626)
private val WinGreen = Color(0xFF15803D)

private val LeagueColors = mapOf(
  "nba" to Color(0xFF0C2340),
  "mlb" to Color(0xFF002B5C),
  "nfl" to Color(0xFF4F2683),
)

/* ------------------------------------------------------------------ */
/*  Main widget                                                         */
/* ------------------------------------------------------------------ */

@Composable
fun SportsWidget(
  sportsData: SportsResponse?,
  isLoading: Boolean,
  error: String? = null,
  lastUpdatedMillis: Long? = null,
  onRetry: (() -> Unit)? = null,
) {
  val games = sportsData?.games.orEmpty()

  // Don't render at all if no games today
  if (!isLoading && games.isEmpty()) return

  val hasLive = games.any { it.status == "in" || it.status == "halftime" }

  WidgetShell(
    title = if (hasLive) "MN Sports — LIVE" else "MN Sports Today",
    icon = Icons.Default.EmojiEvents,
    category = WidgetCategory.PRODUCTIVITY,
    isLoading = isLoading && sportsData == null,
    error = if (sportsData == null) error else null,
    onRetry = if (sportsData == null) onRetry else null,
    lastUpdated = lastUpdatedMillis,
  ) {
    if (isLoading && sportsData == null) {
      Text(
        text = "Loading game data...",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      return@WidgetShell
    }

    Column(
      modifier = Modifier.fillMaxWidth(),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      games.forEach { game ->
        GameCard(game)
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Single game card                                                    */
/* ------------------------------------------------------------------ */

@Composable
private fun GameCard(game: GameInfo) {
  val isLive = game.status == "in" || game.status == "halftime"
  val isFinished = game.status == "post"
  val isUpcoming = game.status == "pre"

  val borderColor = if (isLive) LiveBorderLight
    else MaterialTheme.colorScheme.outlineVariant
  val bgColor = if (isLive) LiveBgLight
    else if (isFinished) MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f)
    else MaterialTheme.colorScheme.surface

  Column(
    modifier = Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(12.dp))
      .border(1.dp, borderColor, RoundedCornerShape(12.dp))
      .background(bgColor)
      .padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    // Header: League badge + status
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      LeagueBadge(game.league, game.teamColor)

      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        if (isLive && game.statusDetail.isNotBlank()) {
          Text(
            text = game.statusDetail,
            style = MaterialTheme.typography.labelSmall,
            color = LiveRed,
            fontWeight = FontWeight.Medium,
          )
        }
        StatusBadge(game)
      }
    }

    // Matchup row
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      // Team
      TeamColumn(
        name = game.teamName,
        record = game.teamRecord,
        logo = game.teamLogo,
        abbreviation = game.teamAbbreviation,
        color = game.teamColor,
        isWinning = (isLive || isFinished) && game.teamWinning,
        modifier = Modifier.weight(1f),
        alignment = Alignment.Start,
      )

      // Score or VS
      ScoreOrVs(game, isLive, isFinished)

      // Opponent
      TeamColumn(
        name = game.opponentName,
        record = game.opponentRecord,
        logo = game.opponentLogo,
        abbreviation = game.opponentAbbreviation,
        color = "",
        isWinning = (isLive || isFinished) && !game.teamWinning && game.teamScore != game.opponentScore,
        modifier = Modifier.weight(1f),
        alignment = Alignment.End,
      )
    }

    // Details: time, venue, broadcast
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.spacedBy(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      if (isUpcoming && game.gameTimeFormatted.isNotBlank()) {
        DetailChip(Icons.Default.Schedule, game.gameTimeFormatted)
      }
      if (game.venue.isNotBlank()) {
        DetailChip(Icons.Default.LocationOn, game.venue)
      }
      if (game.broadcasts.isNotEmpty()) {
        DetailChip(Icons.Default.Tv, game.broadcasts.joinToString(", "))
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                      */
/* ------------------------------------------------------------------ */

@Composable
private fun LeagueBadge(league: String, teamColor: String) {
  val color = LeagueColors[league] ?: parseHexColor(teamColor)
  Text(
    text = league.uppercase(),
    style = MaterialTheme.typography.labelSmall,
    fontWeight = FontWeight.Bold,
    color = color,
    modifier = Modifier
      .border(1.dp, color.copy(alpha = 0.5f), RoundedCornerShape(4.dp))
      .padding(horizontal = 6.dp, vertical = 2.dp),
  )
}

@Composable
private fun StatusBadge(game: GameInfo) {
  when (game.status) {
    "in", "halftime" -> {
      val infiniteTransition = rememberInfiniteTransition(label = "live-pulse")
      val alpha by infiniteTransition.animateFloat(
        initialValue = 1f,
        targetValue = 0.4f,
        animationSpec = infiniteRepeatable(
          animation = tween(800),
          repeatMode = RepeatMode.Reverse,
        ),
        label = "live-alpha",
      )
      Text(
        text = if (game.status == "halftime") "HALFTIME" else "LIVE",
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Bold,
        color = Color.White,
        modifier = Modifier
          .background(
            LiveRed.copy(alpha = alpha),
            RoundedCornerShape(4.dp),
          )
          .padding(horizontal = 8.dp, vertical = 2.dp),
      )
    }
    "post" -> {
      Text(
        text = "FINAL",
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
          .background(
            MaterialTheme.colorScheme.surfaceVariant,
            RoundedCornerShape(4.dp),
          )
          .padding(horizontal = 8.dp, vertical = 2.dp),
      )
    }
    "delayed" -> {
      Text(
        text = "DELAYED",
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.SemiBold,
        color = Color(0xFFC27803),
        modifier = Modifier
          .border(1.dp, Color(0xFFFBBF24), RoundedCornerShape(4.dp))
          .padding(horizontal = 8.dp, vertical = 2.dp),
      )
    }
    "postponed" -> {
      Text(
        text = "POSTPONED",
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
          .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(4.dp))
          .padding(horizontal = 8.dp, vertical = 2.dp),
      )
    }
  }
}

@Composable
private fun TeamColumn(
  name: String,
  record: String,
  logo: String,
  abbreviation: String,
  color: String,
  isWinning: Boolean,
  modifier: Modifier = Modifier,
  alignment: Alignment.Horizontal,
) {
  Column(
    modifier = modifier,
    horizontalAlignment = alignment,
  ) {
    if (logo.isNotBlank()) {
      AsyncImage(
        model = ImageRequest.Builder(LocalContext.current)
          .data(logo)
          .crossfade(true)
          .build(),
        contentDescription = name,
        modifier = Modifier.size(32.dp),
        contentScale = ContentScale.Fit,
      )
    } else {
      val bgColor = parseHexColor(color)
      Box(
        modifier = Modifier
          .size(32.dp)
          .clip(CircleShape)
          .background(bgColor),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          text = abbreviation.take(3),
          style = MaterialTheme.typography.labelSmall,
          fontWeight = FontWeight.Bold,
          color = Color.White,
        )
      }
    }
    Spacer(Modifier.height(4.dp))
    Text(
      text = name,
      style = MaterialTheme.typography.bodySmall,
      fontWeight = FontWeight.SemiBold,
      color = if (isWinning) WinGreen else MaterialTheme.colorScheme.onSurface,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      textAlign = if (alignment == Alignment.End) TextAlign.End else TextAlign.Start,
    )
    if (record.isNotBlank()) {
      Text(
        text = record,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}

@Composable
private fun ScoreOrVs(game: GameInfo, isLive: Boolean, isFinished: Boolean) {
  if ((isLive || isFinished) && game.teamScore != null && game.opponentScore != null) {
    Row(
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(4.dp),
      modifier = Modifier.padding(horizontal = 8.dp),
    ) {
      Text(
        text = "${game.teamScore}",
        fontSize = 22.sp,
        fontWeight = FontWeight.Bold,
        color = if (game.teamWinning) MaterialTheme.colorScheme.onSurface
          else MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Text(
        text = "-",
        fontSize = 16.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Text(
        text = "${game.opponentScore}",
        fontSize = 22.sp,
        fontWeight = FontWeight.Bold,
        color = if (!game.teamWinning) MaterialTheme.colorScheme.onSurface
          else MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  } else {
    Text(
      text = if (game.isHome) "vs" else "@",
      style = MaterialTheme.typography.bodyMedium,
      fontWeight = FontWeight.Medium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = Modifier.padding(horizontal = 8.dp),
    )
  }
}

@Composable
private fun DetailChip(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
  Row(
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(3.dp),
  ) {
    Icon(
      imageVector = icon,
      contentDescription = null,
      modifier = Modifier.size(12.dp),
      tint = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Text(
      text = text,
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

private fun parseHexColor(hex: String): Color {
  if (hex.isBlank()) return Color.Gray
  return try {
    val cleaned = hex.removePrefix("#")
    Color(android.graphics.Color.parseColor("#$cleaned"))
  } catch (_: Exception) {
    Color.Gray
  }
}
