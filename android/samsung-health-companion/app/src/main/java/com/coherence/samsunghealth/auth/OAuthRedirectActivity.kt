package com.coherence.samsunghealth.auth

import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import com.coherence.samsunghealth.CoherenceApplication
import com.coherence.samsunghealth.MainActivity

/**
 * Handles the OAuth redirect deep link (coherence://auth-callback?token=...).
 * Extracts the JWT session token, saves it, and launches MainActivity.
 */
class OAuthRedirectActivity : ComponentActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handleIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleIntent(intent)
  }

  private fun handleIntent(intent: Intent?) {
    val uri = intent?.data
    val token = uri?.getQueryParameter("token")

    if (!token.isNullOrBlank()) {
      Log.d("OAuthRedirect", "Received auth token, saving session")
      val app = application as CoherenceApplication
      app.authManager.saveSessionToken(token)
    } else {
      Log.w("OAuthRedirect", "No token in callback URI: $uri")
    }

    // Launch MainActivity and clear the back stack so user lands on the dashboard
    val mainIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
    }
    startActivity(mainIntent)
    finish()
  }
}
