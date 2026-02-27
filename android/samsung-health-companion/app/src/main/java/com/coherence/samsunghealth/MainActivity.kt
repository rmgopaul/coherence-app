package com.coherence.samsunghealth

import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.lifecycleScope
import com.coherence.samsunghealth.sdk.SamsungHealthDataSdkRepository
import com.coherence.samsunghealth.sync.AutoSyncScheduler
import com.coherence.samsunghealth.sync.WebhookClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

  private lateinit var statusText: TextView
  private lateinit var detailText: TextView
  private lateinit var autoSyncText: TextView
  private lateinit var repository: SamsungHealthDataSdkRepository

  private val permissionRequestLauncher =
    registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
      Toast.makeText(this, "Granted ${granted.size} permissions", Toast.LENGTH_SHORT).show()
      refreshConnectionStatus()
    }

  private val healthConnectSettingsLauncher =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
      refreshConnectionStatus()
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    repository = SamsungHealthDataSdkRepository(applicationContext)

    val container = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(48, 72, 48, 48)
    }

    val title = TextView(this).apply {
      text = "Coherence Samsung Health Sync"
      textSize = 22f
    }

    val subtitle = TextView(this).apply {
      text = "Step 2: Health Connect read flow is enabled. Grant permissions, then sync to push live data to Coherence."
      textSize = 14f
      setPadding(0, 24, 0, 18)
    }

    statusText = TextView(this).apply {
      text = "Checking Health Connect status..."
      textSize = 14f
      setPadding(0, 0, 0, 8)
    }

    detailText = TextView(this).apply {
      text = ""
      textSize = 12f
      setPadding(0, 0, 0, 24)
    }

    autoSyncText = TextView(this).apply {
      text = ""
      textSize = 12f
      setPadding(0, 0, 0, 20)
    }

    val openHealthSettingsButton = Button(this).apply {
      text = "Open Health Connect"
      setOnClickListener {
        runCatching {
          healthConnectSettingsLauncher.launch(SamsungHealthDataSdkRepository.buildHealthConnectSettingsIntent())
        }.onFailure {
          Toast.makeText(this@MainActivity, "Health Connect settings unavailable", Toast.LENGTH_SHORT).show()
        }
      }
    }

    val requestPermissionsButton = Button(this).apply {
      text = "Grant Core Permissions"
      setOnClickListener {
        lifecycleScope.launch {
          val status = repository.getConnectionStatus()
          val missing = SamsungHealthDataSdkRepository.coreReadPermissions - status.grantedPermissions
          if (missing.isEmpty()) {
            Toast.makeText(this@MainActivity, "Core permissions already granted", Toast.LENGTH_SHORT).show()
          } else {
            runCatching {
              permissionRequestLauncher.launch(missing)
            }.onFailure {
              Toast.makeText(
                this@MainActivity,
                "Permission prompt failed: ${it.message ?: "unknown error"}",
                Toast.LENGTH_LONG
              ).show()
            }
          }
        }
      }
    }

    val runNowButton = Button(this).apply {
      text = "Sync Now"
      setOnClickListener {
        lifecycleScope.launch {
          this@apply.isEnabled = false
          try {
            val payload = withContext(Dispatchers.IO) { repository.collectDailyPayload() }
            val result = withContext(Dispatchers.IO) { WebhookClient().postSamsungHealth(payload) }
            if (result.success) {
              Toast.makeText(this@MainActivity, "Samsung sync sent", Toast.LENGTH_SHORT).show()
            } else {
              Toast.makeText(
                this@MainActivity,
                "Sync failed (${result.statusCode})",
                Toast.LENGTH_LONG
              ).show()
            }
          } catch (error: Throwable) {
            Toast.makeText(
              this@MainActivity,
              "Sync failed: ${error.message ?: "unknown"}",
              Toast.LENGTH_LONG
            ).show()
          } finally {
            this@apply.isEnabled = true
          }
        }
      }
    }

    val scheduleButton = Button(this).apply {
      text = "Enable 15-min Auto Sync"
      setOnClickListener {
        AutoSyncScheduler.enable(this@MainActivity)
        updateAutoSyncStatus()
        Toast.makeText(this@MainActivity, "Auto sync enabled (runs now + every ~15 min)", Toast.LENGTH_SHORT).show()
      }
    }

    container.addView(title)
    container.addView(subtitle)
    container.addView(statusText)
    container.addView(detailText)
    container.addView(autoSyncText)
    container.addView(openHealthSettingsButton)
    container.addView(requestPermissionsButton)
    container.addView(runNowButton)
    container.addView(scheduleButton)

    setContentView(container)
    AutoSyncScheduler.ensureScheduledIfEnabled(this)
    updateAutoSyncStatus()
    refreshConnectionStatus()
  }

  override fun onResume() {
    super.onResume()
    AutoSyncScheduler.ensureScheduledIfEnabled(this)
    updateAutoSyncStatus()
    refreshConnectionStatus()
  }

  private fun updateAutoSyncStatus() {
    val enabled = AutoSyncScheduler.isEnabled(this)
    autoSyncText.text =
      if (enabled) {
        "Auto-sync: enabled (runs now + every ~15 minutes; Android may delay during battery optimization)"
      } else {
        "Auto-sync: disabled"
      }
  }

  private fun refreshConnectionStatus() {
    lifecycleScope.launch {
      val status = repository.getConnectionStatus()
      val sdkText = when (status.sdkStatusCode) {
        HealthConnectClient.SDK_AVAILABLE -> "available"
        else -> "status=${status.sdkStatusCode}"
      }

      statusText.text = "Health Connect: $sdkText"
      val grantedTracked = status.grantedPermissions.intersect(SamsungHealthDataSdkRepository.requiredReadPermissions).size
      val grantedCore = status.grantedPermissions.intersect(SamsungHealthDataSdkRepository.coreReadPermissions).size
      val grantedOptional = status.grantedPermissions.intersect(SamsungHealthDataSdkRepository.optionalReadPermissions).size
      val missingPreview = status.missingPermissions.take(3).joinToString(", ")
      val missingSuffix = if (status.missingPermissions.size > 3) ", ..." else ""
      detailText.text =
        "Permissions granted: $grantedTracked/${SamsungHealthDataSdkRepository.requiredReadPermissions.size}" +
          "\nCore: $grantedCore/${SamsungHealthDataSdkRepository.coreReadPermissions.size} | Optional: $grantedOptional/${SamsungHealthDataSdkRepository.optionalReadPermissions.size}" +
          if (status.missingPermissions.isNotEmpty()) "\nMissing: $missingPreview$missingSuffix" else ""
    }
  }
}
