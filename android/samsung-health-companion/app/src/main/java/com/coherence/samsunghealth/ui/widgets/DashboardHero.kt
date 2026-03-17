package com.coherence.samsunghealth.ui.widgets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.LocalFireDepartment
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

data class HeroStats(
  val tasksDueToday: Int = 0,
  val recoveryPercent: Int? = null,
  val habitStreak: Int? = null,
  val eventsToday: Int = 0,
)

@Composable
fun DashboardHero(
  stats: HeroStats,
  modifier: Modifier = Modifier,
) {
  val hour = remember { LocalTime.now().hour }
  val greeting = remember(hour) {
    when (hour) {
      in 5..11 -> "Good morning"
      in 12..17 -> "Good afternoon"
      else -> "Good evening"
    }
  }

  val dateText = remember {
    LocalDate.now().format(
      DateTimeFormatter.ofPattern("EEEE, MMMM d", Locale.getDefault()),
    )
  }

  val gradientColors = remember(hour) {
    when (hour) {
      in 5..8 -> listOf(Color(0xFFFFA726), Color(0xFFFF7043), Color(0xFFE91E63))   // sunrise
      in 9..11 -> listOf(Color(0xFF42A5F5), Color(0xFF5C6BC0), Color(0xFF7E57C2))  // morning
      in 12..17 -> listOf(Color(0xFF1E88E5), Color(0xFF1565C0), Color(0xFF0D47A1)) // afternoon
      in 18..20 -> listOf(Color(0xFFFF7043), Color(0xFFAB47BC), Color(0xFF5C6BC0)) // sunset
      else -> listOf(Color(0xFF283593), Color(0xFF1A237E), Color(0xFF0D1B3E))      // night
    }
  }

  Box(
    modifier = modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(16.dp))
      .background(Brush.linearGradient(gradientColors))
      .padding(20.dp),
  ) {
    Column {
      Text(
        text = greeting,
        style = MaterialTheme.typography.headlineMedium,
        color = Color.White,
        fontWeight = FontWeight.Bold,
      )
      Spacer(Modifier.height(2.dp))
      Text(
        text = dateText,
        style = MaterialTheme.typography.bodyLarge,
        color = Color.White.copy(alpha = 0.85f),
      )
      Spacer(Modifier.height(16.dp))

      // Quick stats
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceEvenly,
      ) {
        HeroStat(
          icon = Icons.Default.CheckCircle,
          value = "${stats.tasksDueToday}",
          label = "Due today",
        )
        HeroStat(
          icon = Icons.Default.Timer,
          value = "${stats.eventsToday}",
          label = "Events",
        )
        stats.recoveryPercent?.let {
          HeroStat(
            icon = Icons.Default.FavoriteBorder,
            value = "$it%",
            label = "Recovery",
          )
        }
        stats.habitStreak?.let {
          HeroStat(
            icon = Icons.Default.LocalFireDepartment,
            value = "$it",
            label = "Streak",
          )
        }
      }
    }
  }
}

@Composable
private fun HeroStat(
  icon: ImageVector,
  value: String,
  label: String,
) {
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Icon(
      icon,
      contentDescription = null,
      tint = Color.White.copy(alpha = 0.9f),
      modifier = Modifier.size(20.dp),
    )
    Spacer(Modifier.height(4.dp))
    Text(
      text = value,
      style = MaterialTheme.typography.titleMedium,
      color = Color.White,
      fontWeight = FontWeight.Bold,
    )
    Text(
      text = label,
      style = MaterialTheme.typography.labelSmall,
      color = Color.White.copy(alpha = 0.75f),
    )
  }
}
