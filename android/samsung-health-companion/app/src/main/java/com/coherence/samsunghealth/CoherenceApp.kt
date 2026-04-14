package com.coherence.samsunghealth

import android.app.Application
import com.coherence.samsunghealth.auth.AuthManager
import com.coherence.samsunghealth.di.AppContainer

/**
 * Application-level singleton. Delegates all dependency wiring to [AppContainer].
 */
class CoherenceApplication : Application() {

  lateinit var container: AppContainer
    private set

  // Convenience accessors for the most commonly used dependencies
  val authManager: AuthManager get() = container.authManager

  override fun onCreate() {
    super.onCreate()
    container = AppContainer(this)
  }
}
