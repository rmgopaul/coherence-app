package com.coherence.samsunghealth.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.data.model.User
import com.coherence.samsunghealth.ui.LocalApp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit) {
  val app = LocalApp.current

  var user by remember { mutableStateOf<User?>(null) }
  var serverReachable by remember { mutableStateOf<Boolean?>(null) }

  LaunchedEffect(Unit) {
    try {
      user = app.authRepository.getMe()
      serverReachable = true
    } catch (_: Exception) {
      serverReachable = false
    }
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Settings") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
          }
        },
      )
    },
  ) { padding ->
    LazyColumn(
      modifier = Modifier.fillMaxSize().padding(padding),
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      // Account info
      item {
        Card(
          colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
          elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        ) {
          Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Text("Account", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            if (user != null) {
              user?.name?.let { name ->
                Text(name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
              }
              user?.email?.let { email ->
                Text(email, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
              }
              user?.loginMethod?.let { method ->
                Text("Login: $method", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
              }
            } else {
              Text("Loading...", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
          }
        }
      }

      // Server status
      item {
        Card(
          colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
          elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        ) {
          Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              Icon(Icons.Default.Cloud, contentDescription = null, modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
              Spacer(Modifier.width(8.dp))
              Text("Server Connection", style = MaterialTheme.typography.titleMedium)
            }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
              when (serverReachable) {
                true -> {
                  Icon(Icons.Default.CheckCircle, contentDescription = null, modifier = Modifier.size(16.dp), tint = Color(0xFF22C55E))
                  Spacer(Modifier.width(6.dp))
                  Text("Connected", color = Color(0xFF22C55E))
                }
                false -> {
                  Icon(Icons.Default.Error, contentDescription = null, modifier = Modifier.size(16.dp), tint = Color(0xFFEF4444))
                  Spacer(Modifier.width(6.dp))
                  Text("Unreachable", color = Color(0xFFEF4444))
                }
                null -> {
                  Icon(Icons.Default.Sync, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                  Spacer(Modifier.width(6.dp))
                  Text("Checking...", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
              }
            }
            Text(
              "app.coherence-rmg.com",
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
              modifier = Modifier.padding(top = 4.dp),
            )
          }
        }
      }

      // App info
      item {
        Card(
          colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
          elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        ) {
          Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              Icon(Icons.Default.Info, contentDescription = null, modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
              Spacer(Modifier.width(8.dp))
              Text("App Info", style = MaterialTheme.typography.titleMedium)
            }
            Spacer(Modifier.height(8.dp))
            Text("Coherence Dashboard", style = MaterialTheme.typography.bodyMedium)
            Text("Version 0.2.0", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Samsung Health Sync + Productivity Hub", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
      }

      // Health Connect sync info
      item {
        Card(
          colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
          elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        ) {
          Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              Icon(Icons.Default.Sync, contentDescription = null, modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
              Spacer(Modifier.width(8.dp))
              Text("Health Connect Sync", style = MaterialTheme.typography.titleMedium)
            }
            Spacer(Modifier.height(8.dp))
            Text("Background sync runs every 15 minutes via WorkManager", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
      }

      // Sign out
      item {
        Spacer(Modifier.height(8.dp))
        Button(
          onClick = { app.authManager.clearSession() },
          modifier = Modifier.fillMaxWidth(),
          colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFEF4444)),
        ) {
          Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null, modifier = Modifier.size(20.dp))
          Spacer(Modifier.width(8.dp))
          Text("Sign Out")
        }
      }
    }
  }
}
