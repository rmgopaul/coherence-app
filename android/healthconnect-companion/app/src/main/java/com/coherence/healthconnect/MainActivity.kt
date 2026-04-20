package com.coherence.healthconnect

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.coherence.healthconnect.sync.AutoSyncScheduler
import com.coherence.healthconnect.ui.CoherenceAppUi

class MainActivity : ComponentActivity() {

  private val app by lazy { application as CoherenceApplication }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()

    // Maintain existing health sync scheduling
    AutoSyncScheduler.ensureScheduledIfEnabled(this)

    setContent {
      CoherenceAppUi(app = app)
    }
  }

  override fun onResume() {
    super.onResume()
    // Keep the periodic worker scheduled, then opportunistically fire
    // a manual sync. `triggerManualSync` is debounced internally so
    // tab swipes and frequent app re-entries don't hammer the
    // HealthConnect quota.
    AutoSyncScheduler.ensureScheduledIfEnabled(this)
    AutoSyncScheduler.triggerManualSync(this)
  }
}
