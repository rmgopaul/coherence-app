package com.coherence.healthconnect.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

@Composable
fun PinScreen(onUnlocked: (pinCookieValue: String) -> Unit) {
  var pin by remember { mutableStateOf("") }
  var error by remember { mutableStateOf<String?>(null) }
  var isLoading by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()

  fun submit() {
    if (pin.isBlank()) return
    isLoading = true
    error = null
    scope.launch {
      try {
        val result = verifyPin(pin)
        if (result.success) {
          onUnlocked(result.cookieValue)
        } else {
          error = result.errorMessage ?: "Invalid PIN"
        }
      } catch (e: Exception) {
        error = "Connection error: ${e.message}"
      }
      isLoading = false
    }
  }

  // Wrap in Surface so Material 3 propagates onBackground/onSurface
  // through LocalContentColor — without this, bare Text() falls back
  // to literal Color.Black, which renders as dark-on-dark in Ink mode.
  Surface(
    modifier = Modifier.fillMaxSize(),
    color = MaterialTheme.colorScheme.background,
    contentColor = MaterialTheme.colorScheme.onBackground,
  ) {
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
        text = "PIN Protected",
        style = MaterialTheme.typography.headlineMedium,
        color = MaterialTheme.colorScheme.onBackground,
      )

      Spacer(modifier = Modifier.height(8.dp))

      Text(
        text = "Enter your PIN to unlock the app",
        style = MaterialTheme.typography.bodyLarge,
        textAlign = TextAlign.Center,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )

      Spacer(modifier = Modifier.height(32.dp))

      OutlinedTextField(
        value = pin,
        onValueChange = { pin = it; error = null },
        label = { Text("PIN") },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(
          keyboardType = KeyboardType.NumberPassword,
          imeAction = ImeAction.Go,
        ),
        keyboardActions = KeyboardActions(onGo = { submit() }),
        singleLine = true,
        isError = error != null,
        modifier = Modifier.fillMaxWidth(),
      )

      if (error != null) {
        Spacer(modifier = Modifier.height(8.dp))
        Text(
          text = error!!,
          color = MaterialTheme.colorScheme.error,
          style = MaterialTheme.typography.bodySmall,
        )
      }

      Spacer(modifier = Modifier.height(16.dp))

      Button(
        onClick = { submit() },
        enabled = pin.isNotBlank() && !isLoading,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Text(if (isLoading) "Verifying..." else "Unlock")
      }
    }
  }
}

private data class PinResult(
  val success: Boolean,
  val cookieValue: String = "",
  val errorMessage: String? = null,
)

private suspend fun verifyPin(pin: String): PinResult = withContext(Dispatchers.IO) {
  val client = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(15, TimeUnit.SECONDS)
    .build()

  val baseUrl = BuildConfig.BASE_URL.trimEnd('/')
  val body = buildJsonObject { put("pin", pin) }.toString()
  val request = Request.Builder()
    .url("$baseUrl/api/pin/verify")
    .post(body.toRequestBody("application/json".toMediaType()))
    .build()

  val response = client.newCall(request).execute()
  val responseBody = response.body?.string() ?: ""

  if (response.isSuccessful) {
    // Extract the coherence_pin_gate cookie from response headers
    val setCookieHeaders = response.headers("Set-Cookie")
    val pinCookie = setCookieHeaders
      .firstOrNull { it.startsWith("coherence_pin_gate=") }
      ?.substringAfter("coherence_pin_gate=")
      ?.substringBefore(";")
      ?: ""

    PinResult(success = true, cookieValue = pinCookie)
  } else {
    val errorMsg = try {
      val parsed = Json.parseToJsonElement(responseBody)
      parsed.jsonObject["error"]?.jsonPrimitive?.content ?: "Invalid PIN"
    } catch (_: Exception) {
      "Invalid PIN"
    }
    PinResult(success = false, errorMessage = errorMsg)
  }
}
