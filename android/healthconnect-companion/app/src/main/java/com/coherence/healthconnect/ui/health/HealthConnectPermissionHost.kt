package com.coherence.healthconnect.ui.health

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.sdk.HealthConnectPermissionManager
import com.coherence.healthconnect.sdk.HealthConnectStatus
import com.coherence.healthconnect.ui.LocalApp
import kotlinx.coroutines.launch

/**
 * Reusable card that:
 *  - Surfaces the current Health Connect permission state.
 *  - Launches the Health Connect permission dialog when the user
 *    clicks "Grant permissions".
 *  - Falls back to opening Health Connect settings when the SDK is
 *    not available (so the user can install it).
 *
 * Drop this in any screen that needs to gate Health Connect access —
 * the HealthScreen and SettingsScreen both use it.
 */
@Composable
fun HealthConnectPermissionHost(
  onStatusChanged: (HealthConnectStatus) -> Unit = {},
) {
  val app = LocalApp.current
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val permissionManager = app.container.healthConnectPermissionManager

  var status by remember { mutableStateOf<HealthConnectStatus?>(null) }

  val permissionLauncher = rememberLauncherForActivityResult(
    contract = HealthConnectPermissionManager.createPermissionRequestContract(),
  ) { _ ->
    // The contract returns the granted set, but we fetch status from
    // the source of truth so a single code path handles both
    // "launcher returned" and "user came back from settings".
    scope.launch {
      val next = permissionManager.getStatus()
      status = next
      onStatusChanged(next)
    }
  }

  LaunchedEffect(Unit) {
    val initial = permissionManager.getStatus()
    status = initial
    onStatusChanged(initial)
  }

  val current = status ?: return

  when {
    !current.sdkAvailable -> PermissionCard(
      title = "Health Connect not available",
      body = "Install or update the Health Connect app from the Play Store, " +
        "then return here to grant permissions.",
      buttonLabel = "Open Health Connect",
      onClick = {
        runCatching {
          context.startActivity(
            HealthConnectPermissionManager.buildHealthConnectSettingsIntent()
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
        }
      },
    )
    !current.permissionsGranted -> PermissionCard(
      title = "Grant Health Connect permissions",
      body = "Coherence needs read access to steps, sleep, heart rate, and " +
        "other health data to keep your dashboard in sync.",
      buttonLabel = "Grant permissions",
      onClick = {
        permissionLauncher.launch(HealthConnectPermissionManager.allPermissions)
      },
    )
    else -> {
      // Fully granted — render nothing. Host screens decide what to
      // show in the "ready" state (usually: sync status + data).
    }
  }
}

@Composable
private fun PermissionCard(
  title: String,
  body: String,
  buttonLabel: String,
  onClick: () -> Unit,
) {
  Card(
    modifier = Modifier.fillMaxWidth(),
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(title, style = MaterialTheme.typography.titleMedium)
      Text(body, style = MaterialTheme.typography.bodyMedium)
      Spacer(Modifier.height(4.dp))
      Button(onClick = onClick) { Text(buttonLabel) }
    }
  }
}
