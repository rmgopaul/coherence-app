package com.coherence.samsunghealth

import android.app.Application
import com.coherence.samsunghealth.sync.SamsungSyncWorker

class SamsungHealthApp : Application() {
  override fun onCreate() {
    super.onCreate()
    // Keep the periodic background sync scheduled across app
    // restarts. WorkManager dedups via the unique-work name.
    SamsungSyncWorker.ensureScheduled(this)
  }
}
