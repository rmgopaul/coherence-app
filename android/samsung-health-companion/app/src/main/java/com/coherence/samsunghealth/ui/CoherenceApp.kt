package com.coherence.samsunghealth.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.CoherenceApplication
import com.coherence.samsunghealth.data.model.AppPreferences
import com.coherence.samsunghealth.ui.navigation.AppNavGraph
import com.coherence.samsunghealth.ui.screens.LoginScreen
import com.coherence.samsunghealth.ui.screens.PinScreen
import com.coherence.samsunghealth.ui.theme.CoherenceTheme

val LocalApp = compositionLocalOf<CoherenceApplication> {
  error("No CoherenceApplication provided")
}

@Composable
fun CoherenceAppUi(app: CoherenceApplication) {
  val preferences by app.appPreferencesRepository.preferences.collectAsState(initial = AppPreferences())

  CoherenceTheme(
    themeMode = preferences.themeMode,
    dynamicColor = preferences.dynamicColorEnabled,
    trueBlack = preferences.trueBlackEnabled,
  ) {
    CompositionLocalProvider(LocalApp provides app) {
      val isAuthenticated by app.authManager.isAuthenticated.collectAsState()
      val isPinUnlocked by app.authManager.isPinUnlocked.collectAsState()
      var apiCheckDone by remember { mutableStateOf(false) }

      // Check PIN status on first launch
      LaunchedEffect(Unit) {
        app.authManager.checkPinStatus()
      }

      // After PIN is unlocked, try direct API access before showing WebView
      LaunchedEffect(isPinUnlocked) {
        if (isPinUnlocked == true && !isAuthenticated) {
          app.authManager.tryDirectApiAccess()
          apiCheckDone = true
        }
      }

      when {
        // Still checking PIN status
        isPinUnlocked == null -> {
          LoadingScreen("Connecting...")
        }
        // PIN is required and not yet unlocked
        isPinUnlocked == false -> {
          PinScreen(
            onUnlocked = { pinCookieValue ->
              app.authManager.savePinCookie(pinCookieValue)
            },
          )
        }
        // Authenticated (via session cookie or auth bypass) — show native app
        isAuthenticated -> {
          AppNavGraph()
        }
        // Still checking if API is directly accessible
        !apiCheckDone -> {
          LoadingScreen("Checking access...")
        }
        // Not authenticated and API requires login — show WebView
        else -> {
          LoginScreen(authManager = app.authManager)
        }
      }
    }
  }
}

@Composable
private fun LoadingScreen(message: String) {
  Column(
    modifier = Modifier.fillMaxSize(),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    CircularProgressIndicator()
    Spacer(Modifier.height(12.dp))
    Text(message)
  }
}
