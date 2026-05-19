package com.coherence.samsunghealth

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import com.coherence.samsunghealth.sdk.SamsungHealthReader
import com.coherence.samsunghealth.sync.SamsungSyncManager
import com.coherence.samsunghealth.sync.WebhookResult
import com.coherence.samsunghealth.ui.StatusScreen
import kotlinx.coroutines.launch
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/**
 * Single-Activity host for the minimal status screen. Owns the
 * Samsung Health permission flow (the SDK's
 * `requestPermissions(Set, Activity)` needs a foreground Activity)
 * and a manual "Sync now" trigger.
 */
class MainActivity : ComponentActivity() {

  private val reader by lazy { SamsungHealthReader(applicationContext) }
  private val syncManager by lazy { SamsungSyncManager(applicationContext) }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    setContent {
      MaterialTheme {
        Surface {
          var permissionStatus by remember { mutableStateOf("checking…") }
          var lastSync by remember { mutableStateOf("never") }
          val scope = rememberCoroutineScope()

          // Initial permission probe.
          LaunchedPermissionProbe { permissionStatus = it }

          StatusScreen(
            permissionStatus = permissionStatus,
            lastSync = lastSync,
            onRequestPermissions = {
              scope.launch {
                runCatching { reader.requestPermissions(this@MainActivity) }
                  .onSuccess {
                    permissionStatus =
                      if (it.containsAll(reader.requiredPermissions())) "granted"
                      else "partial (${it.size}/2)"
                  }
                  .onFailure { permissionStatus = "error: ${it.message}" }
              }
            },
            onSyncNow = {
              scope.launch {
                lastSync = "syncing…"
                val result = runCatching { syncManager.syncToday() }
                  .getOrElse { WebhookResult.Permanent(-1, it.message ?: "error") }
                val stamp = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"))
                lastSync = when (result) {
                  is WebhookResult.Success -> "ok at $stamp"
                  is WebhookResult.Retryable -> "retryable at $stamp (${result.message})"
                  is WebhookResult.Permanent -> "failed at $stamp (${result.message})"
                }
              }
            },
          )
        }
      }
    }
  }

  /** Probes granted permissions once on composition. */
  @androidx.compose.runtime.Composable
  private fun LaunchedPermissionProbe(onResult: (String) -> Unit) {
    androidx.compose.runtime.LaunchedEffect(Unit) {
      lifecycleScope.launch {
        val status = runCatching {
          if (reader.hasAllPermissions()) "granted" else "not granted"
        }.getOrElse { "error: ${it.message}" }
        onResult(status)
      }
    }
  }
}
