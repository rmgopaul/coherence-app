package com.coherence.healthconnect.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.CalendarViewWeek
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Medication
import androidx.compose.material.icons.filled.NightsStay
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material.icons.filled.TrackChanges
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.ui.LocalApp

@Composable
fun MoreScreen(
  onNavigateToChat: () -> Unit = {},
  onNavigateToNotes: () -> Unit = {},
  onNavigateToSupplements: () -> Unit = {},
  onNavigateToHabits: () -> Unit = {},
  onNavigateToDailyLog: () -> Unit = {},
  onNavigateToDrive: () -> Unit = {},
  onNavigateToClockify: () -> Unit = {},
  onNavigateToSettings: () -> Unit = {},
  onNavigateToReflection: () -> Unit = {},
  onNavigateToWeeklyReview: () -> Unit = {},
) {
  val app = LocalApp.current

  LazyColumn(
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(16.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    item {
      Text(
        text = "More",
        style = MaterialTheme.typography.headlineMedium,
        modifier = Modifier.padding(bottom = 8.dp),
      )
    }

    item { MoreMenuItem(Icons.AutoMirrored.Filled.Chat, "Chat", "AI-powered conversations") { onNavigateToChat() } }
    item { MoreMenuItem(Icons.Default.NightsStay, "Tonight's reflection", "Energy + journal + tomorrow's one thing") { onNavigateToReflection() } }
    item { MoreMenuItem(Icons.Default.CalendarViewWeek, "Weekly review", "AI summary of your week") { onNavigateToWeeklyReview() } }
    item { MoreMenuItem(Icons.AutoMirrored.Filled.Notes, "Notes", "Your notebook") { onNavigateToNotes() } }
    item { MoreMenuItem(Icons.Default.Medication, "Supplements", "Track daily supplements") { onNavigateToSupplements() } }
    item { MoreMenuItem(Icons.Default.TrackChanges, "Habits", "Daily habit tracking") { onNavigateToHabits() } }
    item { MoreMenuItem(Icons.Default.BarChart, "Daily Log", "Health metrics history") { onNavigateToDailyLog() } }
    item { MoreMenuItem(Icons.Default.Folder, "Drive Files", "Google Drive") { onNavigateToDrive() } }
    item { MoreMenuItem(Icons.Default.Timer, "Clockify", "Time tracking") { onNavigateToClockify() } }
    item { MoreMenuItem(Icons.Default.Settings, "Settings", "App configuration") { onNavigateToSettings() } }
    item {
      MoreMenuItem(
        Icons.AutoMirrored.Filled.Logout,
        "Sign Out",
        "Clear session and sign out",
      ) {
        app.authManager.clearSession()
      }
    }
  }
}

@Composable
private fun MoreMenuItem(
  icon: ImageVector,
  title: String,
  subtitle: String,
  onClick: () -> Unit,
) {
  Card(
    modifier = Modifier
      .fillMaxWidth()
      .clickable(onClick = onClick),
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
  ) {
    Row(
      modifier = Modifier
        .fillMaxWidth()
        .padding(16.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Icon(
        icon,
        contentDescription = null,
        modifier = Modifier.size(24.dp),
        tint = MaterialTheme.colorScheme.primary,
      )
      Spacer(modifier = Modifier.width(16.dp))
      Column {
        Text(
          text = title,
          style = MaterialTheme.typography.bodyLarge,
        )
        Text(
          text = subtitle,
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }
  }
}
