package com.coherence.healthconnect.ui.screens

import android.app.Activity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.auth.AuthManager

@Composable
fun LoginScreen(authManager: AuthManager) {
  val context = LocalContext.current
  val activity = context as? Activity

  Column(
    modifier = Modifier
      .fillMaxSize()
      .padding(32.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Icon(
      Icons.Default.Lock,
      contentDescription = null,
      modifier = Modifier.size(64.dp),
      tint = MaterialTheme.colorScheme.primary,
    )

    Spacer(modifier = Modifier.height(24.dp))

    Text(
      text = "Coherence",
      style = MaterialTheme.typography.headlineMedium,
    )

    Spacer(modifier = Modifier.height(8.dp))

    Text(
      text = "Sign in to access your productivity dashboard",
      style = MaterialTheme.typography.bodyLarge,
      textAlign = TextAlign.Center,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    Spacer(modifier = Modifier.height(32.dp))

    Button(
      onClick = { activity?.let { authManager.launchLogin(it) } },
      enabled = activity != null,
      modifier = Modifier.fillMaxWidth(),
    ) {
      Text("Sign in with Google")
    }

    Spacer(modifier = Modifier.height(12.dp))

    OutlinedButton(
      onClick = { activity?.let { authManager.launchLogin(it) } },
      enabled = activity != null,
      modifier = Modifier.fillMaxWidth(),
    ) {
      Text("Retry Sign In")
    }
  }
}
