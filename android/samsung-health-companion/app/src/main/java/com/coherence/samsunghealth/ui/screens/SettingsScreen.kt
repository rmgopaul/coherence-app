package com.coherence.samsunghealth.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.coherence.samsunghealth.data.model.AppPreferences
import com.coherence.samsunghealth.data.model.ThemeMode
import com.coherence.samsunghealth.data.model.User
import com.coherence.samsunghealth.sdk.HealthConnectCooldown
import com.coherence.samsunghealth.sync.AutoSyncScheduler
import com.coherence.samsunghealth.sync.HistoricalSyncWorker
import com.coherence.samsunghealth.ui.LocalApp
import com.coherence.samsunghealth.ui.health.HealthConnectPermissionHost
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

private val DashboardWidgets = listOf(
  "suggested_actions" to "Suggested Actions",
  "todays_plan" to "Today's Plan",
  "headlines" to "Headlines & Markets",
  "health" to "Samsung Health",
  "whoop" to "WHOOP",
  "focus_timer" to "Focus Timer",
  "tasks" to "Tasks",
  "calendar" to "Calendar",
  "gmail" to "Gmail",
  "habits" to "Habits",
  "supplements" to "Supplements",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit) {
  val app = LocalApp.current
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val preferences by app.container.appPreferencesRepository.preferences.collectAsState(initial = AppPreferences())

  var user by remember { mutableStateOf<User?>(null) }
  var serverReachable by remember { mutableStateOf<Boolean?>(null) }
  var showSignOutConfirm by remember { mutableStateOf(false) }
  var backfillDaysText by remember { mutableStateOf(HistoricalSyncWorker.DEFAULT_DAYS_BACK.toString()) }

  // Observe the backfill worker's live state instead of tracking a
  // local "queued" flag. Local flags reset every time the Settings
  // screen is popped and re-entered — WorkManager's state survives
  // that because it lives in the app-wide WorkManager database.
  val backfillWorkInfos by remember(context) {
    WorkManager.getInstance(context)
      .getWorkInfosForUniqueWorkFlow(HistoricalSyncWorker.WORK_NAME)
  }.collectAsStateWithLifecycle(initialValue = emptyList())
  val backfillState: WorkInfo.State? = backfillWorkInfos
    .firstOrNull { it.state != WorkInfo.State.CANCELLED }?.state
    ?: backfillWorkInfos.firstOrNull()?.state

  // Cooldown state. Polled every 30 s while Settings is on screen so
  // the countdown text stays roughly accurate without burning the
  // main thread. The underlying SharedPreferences read is cheap.
  var cooldownState by remember {
    mutableStateOf<HealthConnectCooldown.State>(app.container.healthConnectCooldown.getState())
  }
  LaunchedEffect(Unit) {
    while (true) {
      cooldownState = app.container.healthConnectCooldown.getState()
      delay(30_000L)
    }
  }

  LaunchedEffect(Unit) {
    try {
      user = app.container.authRepository.getMe()
      serverReachable = true
    } catch (_: Exception) {
      serverReachable = false
    }
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Settings") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
          }
        },
      )
    },
  ) { padding ->
    LazyColumn(
      modifier = Modifier
        .fillMaxSize()
        .padding(padding),
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      item {
        SettingsCard(title = "Appearance", icon = Icons.Default.Palette) {
          OptionGroup(
            title = "Theme mode",
            options = ThemeMode.entries.map { it.name.lowercase().replaceFirstChar { c -> c.uppercase() } },
            selectedIndex = ThemeMode.entries.indexOf(preferences.themeMode),
            onSelected = { index ->
              scope.launch { app.container.appPreferencesRepository.setThemeMode(ThemeMode.entries[index]) }
            },
          )
          SettingToggle(
            title = "Dynamic colors",
            subtitle = "Use Android dynamic color palette when available",
            checked = preferences.dynamicColorEnabled,
            onCheckedChange = { enabled ->
              scope.launch { app.container.appPreferencesRepository.setDynamicColorEnabled(enabled) }
            },
          )
          SettingToggle(
            title = "True black mode",
            subtitle = "Use OLED-friendly black surfaces in dark mode",
            checked = preferences.trueBlackEnabled,
            onCheckedChange = { enabled ->
              scope.launch { app.container.appPreferencesRepository.setTrueBlackEnabled(enabled) }
            },
          )
        }
      }

      item {
        SettingsCard(title = "Dashboard", icon = Icons.Default.Settings) {
          Text("Widget visibility", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium)
          Spacer(Modifier.height(4.dp))
          DashboardWidgets.forEach { (widgetId, label) ->
            SettingToggle(
              title = label,
              subtitle = "Show on dashboard",
              checked = !preferences.hiddenWidgets.contains(widgetId),
              onCheckedChange = { visible ->
                scope.launch { app.container.appPreferencesRepository.setWidgetHidden(widgetId, !visible) }
              },
            )
          }
        }
      }

      item {
        SettingsCard(title = "Health Data", icon = Icons.Default.FavoriteBorder) {
          HealthConnectPermissionHost()

          // Cooldown banner: shown only when the rate-limit cooldown
          // is currently active. Replaces the backfill controls with
          // a clear "wait until X" message because clicking the
          // button while cooled down would just produce another
          // immediate failure.
          if (cooldownState.active && cooldownState.until != null) {
            val remaining = Duration.between(Instant.now(), cooldownState.until)
              .coerceAtLeast(Duration.ZERO)
            val hours = remaining.toHours()
            val minutes = remaining.toMinutes() % 60
            val countdown = when {
              hours >= 1 -> "${hours}h ${minutes}m"
              minutes >= 1 -> "${minutes}m"
              else -> "<1m"
            }
            Card(
              colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.errorContainer,
              ),
            ) {
              Column(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
                Text(
                  text = "Health Connect rate limit hit",
                  style = MaterialTheme.typography.titleSmall,
                  fontWeight = FontWeight.Medium,
                  color = MaterialTheme.colorScheme.onErrorContainer,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                  text = "Sync paused for $countdown to let Google's quota " +
                    "replenish. Periodic syncs and backfills will resume " +
                    "automatically — no action needed.",
                  style = MaterialTheme.typography.bodySmall,
                  color = MaterialTheme.colorScheme.onErrorContainer,
                )
                cooldownState.lastMessage?.let { msg ->
                  Spacer(Modifier.height(4.dp))
                  Text(
                    text = "Last error: $msg",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                  )
                }
              }
            }
          }

          // ── Sync Now (today only) ───────────────────────────────
          Text(
            "Sync today's data",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.Medium,
          )
          Text(
            "Pulls today's Health Connect data immediately. Useful " +
              "when your watch or scale just finished syncing and you " +
              "want the dashboard to reflect it without waiting for " +
              "the hourly schedule.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          Button(
            onClick = {
              // Force-trigger bypasses the onResume debounce so the
              // user gets immediate feedback regardless of how long
              // ago the previous sync fired.
              AutoSyncScheduler.triggerManualSync(context, force = true)
            },
            enabled = !cooldownState.active,
            modifier = Modifier.fillMaxWidth(),
          ) {
            Text(
              if (cooldownState.active) "Sync paused (rate limited)"
              else "Sync Now",
            )
          }

          Spacer(Modifier.height(8.dp))

          // ── Historical backfill ─────────────────────────────────
          Text(
            "Backfill history",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.Medium,
          )
          Text(
            "Pulls the last N days from Health Connect and posts them to " +
              "your dashboard. Health Connect retains up to 30 days.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          Row(verticalAlignment = Alignment.CenterVertically) {
            OptionGroup(
              title = "Days to backfill",
              options = listOf("7", "14", "30"),
              selectedIndex = listOf("7", "14", "30").indexOf(backfillDaysText).coerceAtLeast(2),
              onSelected = { index ->
                backfillDaysText = listOf("7", "14", "30")[index]
              },
            )
          }
          val (buttonLabel, buttonEnabled) = when {
            cooldownState.active -> "Sync paused (rate limited)" to false
            // Only RUNNING is truly non-interactive — tapping during
            // RUNNING could start a second copy mid-execution.
            // ENQUEUED/BLOCKED are interactive: `REPLACE` policy on the
            // unique work cancels any pending backoff and starts fresh,
            // which is what the user almost always wants when they see
            // a stale "queued" label.
            backfillState == WorkInfo.State.RUNNING -> "Backfill running…" to false
            backfillState == WorkInfo.State.ENQUEUED ->
              "Backfill queued — tap to restart now" to true
            backfillState == WorkInfo.State.BLOCKED ->
              "Backfill blocked — tap to retry" to true
            backfillState == WorkInfo.State.FAILED ->
              "Last backfill failed — tap to retry" to true
            backfillState == WorkInfo.State.CANCELLED ->
              "Backfill cancelled — tap to retry" to true
            backfillState == WorkInfo.State.SUCCEEDED ->
              "Backfill complete — run again" to true
            else -> "Start backfill" to true
          }
          Button(
            onClick = {
              val days = backfillDaysText.toIntOrNull()
                ?: HistoricalSyncWorker.DEFAULT_DAYS_BACK
              AutoSyncScheduler.scheduleHistoricalBackfill(context, days)
            },
            enabled = buttonEnabled,
            modifier = Modifier.fillMaxWidth(),
          ) {
            Text(buttonLabel)
          }
          // Surface the most recent failure reason if the worker put
          // one in its output data. The Historical sync worker sets
          // this when a rate-limit error finally exhausts retries.
          val lastFailureMessage = backfillWorkInfos
            .firstOrNull { it.state == WorkInfo.State.FAILED }
            ?.outputData
            ?.getString(HistoricalSyncWorker.KEY_FAILURE_REASON)
          if (!lastFailureMessage.isNullOrBlank()) {
            Text(
              text = lastFailureMessage,
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.error,
            )
          }
        }
      }

      item {
        SettingsCard(title = "Productivity", icon = Icons.Default.Sync) {
          OptionGroup(
            title = "Focus timer duration",
            options = listOf("25 minutes", "50 minutes", "90 minutes"),
            selectedIndex = listOf(25, 50, 90).indexOf(preferences.focusDurationMinutes).coerceAtLeast(0),
            onSelected = { index ->
              val minutes = listOf(25, 50, 90)[index]
              scope.launch { app.container.appPreferencesRepository.setFocusDurationMinutes(minutes) }
            },
          )
          OptionGroup(
            title = "Refresh interval",
            options = listOf("5 min", "15 min", "30 min", "60 min"),
            selectedIndex = listOf(5, 15, 30, 60).indexOf(preferences.refreshIntervalMinutes).coerceAtLeast(1),
            onSelected = { index ->
              val minutes = listOf(5, 15, 30, 60)[index]
              scope.launch { app.container.appPreferencesRepository.setRefreshIntervalMinutes(minutes) }
            },
          )
          OptionGroup(
            title = "Lock timeout",
            options = listOf("Immediate", "1 min", "5 min", "15 min"),
            selectedIndex = listOf(0, 1, 5, 15).indexOf(preferences.lockTimeoutMinutes).coerceAtLeast(2),
            onSelected = { index ->
              val minutes = listOf(0, 1, 5, 15)[index]
              scope.launch { app.container.appPreferencesRepository.setLockTimeoutMinutes(minutes) }
            },
          )
        }
      }

      item {
        Card(
          colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
          elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        ) {
          Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Text("Account", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            if (user != null) {
              user?.name?.let { name ->
                Text(name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
              }
              user?.email?.let { email ->
                Text(email, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
              }
            } else {
              Text("Loading...", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
          }
        }
      }

      item {
        Card(
          colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
          elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        ) {
          Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              Icon(Icons.Default.Cloud, contentDescription = null, modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
              Spacer(Modifier.width(8.dp))
              Text("Server Connection", style = MaterialTheme.typography.titleMedium)
            }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
              when (serverReachable) {
                true -> {
                  Icon(Icons.Default.CheckCircle, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
                  Spacer(Modifier.width(6.dp))
                  Text("Connected", color = MaterialTheme.colorScheme.primary)
                }
                false -> {
                  Icon(Icons.Default.Error, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error)
                  Spacer(Modifier.width(6.dp))
                  Text("Unreachable", color = MaterialTheme.colorScheme.error)
                }
                null -> {
                  Icon(Icons.Default.Sync, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                  Spacer(Modifier.width(6.dp))
                  Text("Checking...", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
              }
            }
          }
        }
      }

      item {
        Card(
          colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
          elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        ) {
          Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              Icon(Icons.Default.Info, contentDescription = null, modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
              Spacer(Modifier.width(8.dp))
              Text("App Info", style = MaterialTheme.typography.titleMedium)
            }
            Spacer(Modifier.height(8.dp))
            Text("Coherence", style = MaterialTheme.typography.bodyMedium)
            Text("Version ${com.coherence.samsunghealth.BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
      }

      item {
        Spacer(Modifier.height(8.dp))
        Button(
          onClick = { showSignOutConfirm = true },
          modifier = Modifier.fillMaxWidth(),
          colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
        ) {
          Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null, modifier = Modifier.size(20.dp))
          Spacer(Modifier.width(8.dp))
          Text("Sign Out")
        }
      }
    }
  }

  if (showSignOutConfirm) {
    AlertDialog(
      onDismissRequest = { showSignOutConfirm = false },
      title = { Text("Sign out?") },
      text = { Text("You will need to log in again to continue.") },
      confirmButton = {
        Button(
          onClick = {
            showSignOutConfirm = false
            app.authManager.clearSession()
          },
          colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
        ) {
          Text("Sign out")
        }
      },
      dismissButton = {
        TextButton(onClick = { showSignOutConfirm = false }) {
          Text("Cancel")
        }
      },
    )
  }
}

@Composable
private fun SettingsCard(
  title: String,
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  content: @Composable () -> Unit,
) {
  Card(
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
  ) {
    Column(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(8.dp))
        Text(title, style = MaterialTheme.typography.titleMedium)
      }
      content()
    }
  }
}

@Composable
private fun SettingToggle(
  title: String,
  subtitle: String,
  checked: Boolean,
  onCheckedChange: (Boolean) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(modifier = Modifier.weight(1f)) {
      Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
      Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Switch(checked = checked, onCheckedChange = onCheckedChange)
  }
}

@Composable
private fun OptionGroup(
  title: String,
  options: List<String>,
  selectedIndex: Int,
  onSelected: (Int) -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium)
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      options.forEachIndexed { index, label ->
        val selected = index == selectedIndex
        Button(
          onClick = { onSelected(index) },
          colors = if (selected) {
            ButtonDefaults.buttonColors()
          } else {
            ButtonDefaults.buttonColors(
              containerColor = MaterialTheme.colorScheme.surfaceVariant,
              contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          },
          contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
        ) {
          Text(label)
        }
      }
    }
  }
}
