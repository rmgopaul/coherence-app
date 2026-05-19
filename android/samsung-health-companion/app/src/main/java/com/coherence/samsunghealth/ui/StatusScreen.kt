package com.coherence.samsunghealth.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * The entire UI for this companion: a permission-request button and
 * a "last sync" status line. No navigation, no widgets, no other
 * screens (scope discipline — see the module README).
 */
@Composable
fun StatusScreen(
  permissionStatus: String,
  lastSync: String,
  onRequestPermissions: () -> Unit,
  onSyncNow: () -> Unit,
) {
  Column(
    modifier = Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState())
      .padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Text(
      text = "Samsung Health Companion",
      style = MaterialTheme.typography.headlineSmall,
    )
    Text(
      text = "Reads Sleep Score + Energy Score from Samsung Health " +
        "and forwards them to the productivity hub.",
      style = MaterialTheme.typography.bodyMedium,
    )

    Text(
      text = "Permissions: $permissionStatus",
      style = MaterialTheme.typography.bodyLarge,
    )
    Button(onClick = onRequestPermissions) {
      Text("Grant Samsung Health permissions")
    }

    Text(
      text = "Last sync: $lastSync",
      style = MaterialTheme.typography.bodyLarge,
    )
    Button(onClick = onSyncNow) {
      Text("Sync now")
    }

    Text(
      text = "Background sync runs automatically every ~3 hours.",
      style = MaterialTheme.typography.bodySmall,
      textAlign = TextAlign.Start,
    )
  }
}
