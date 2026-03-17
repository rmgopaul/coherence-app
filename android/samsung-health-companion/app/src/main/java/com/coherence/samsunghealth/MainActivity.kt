package com.coherence.samsunghealth

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.coherence.samsunghealth.sync.AutoSyncScheduler
import com.coherence.samsunghealth.ui.CoherenceAppUi

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
    // Re-ensure health sync is scheduled
    AutoSyncScheduler.ensureScheduledIfEnabled(this)
  }
}
