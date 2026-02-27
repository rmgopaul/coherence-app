package com.coherence.samsunghealth.sync

import com.coherence.samsunghealth.model.SamsungHealthPayload
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class WebhookClient(
  private val httpClient: OkHttpClient = OkHttpClient(),
  private val json: Json = Json { ignoreUnknownKeys = true; prettyPrint = false },
) {
  fun postSamsungHealth(payload: SamsungHealthPayload): WebhookResult {
    if (!SyncConfig.isConfigured()) {
      return WebhookResult(
        success = false,
        statusCode = -1,
        body = "SyncConfig is not configured. Update WEBHOOK_URL and SYNC_KEY in BuildConfig fields."
      )
    }

    val body = json.encodeToString(payload)
      .toRequestBody("application/json; charset=utf-8".toMediaType())

    val request = Request.Builder()
      .url(SyncConfig.webhookUrl)
      .header("Content-Type", "application/json")
      .header("x-sync-key", SyncConfig.syncKey)
      .post(body)
      .build()

    return httpClient.newCall(request).execute().use { response ->
      WebhookResult(
        success = response.isSuccessful,
        statusCode = response.code,
        body = response.body?.string().orEmpty()
      )
    }
  }
}

data class WebhookResult(
  val success: Boolean,
  val statusCode: Int,
  val body: String,
)
