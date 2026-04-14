package com.coherence.samsunghealth.sync

import com.coherence.samsunghealth.model.SamsungHealthPayload
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * Result of a webhook call. Distinguishes between *retryable*
 * failures (network glitch, 5xx, timeout) and *permanent* failures
 * (401 invalid sync key, 400 bad payload, configuration missing).
 */
sealed class WebhookResult {
  data class Success(val statusCode: Int, val body: String) : WebhookResult()
  data class Retryable(val statusCode: Int, val message: String) : WebhookResult()
  data class Permanent(val statusCode: Int, val message: String) : WebhookResult()

  val isRetryable: Boolean get() = this is Retryable
  val isSuccess: Boolean get() = this is Success
  val isPermanent: Boolean get() = this is Permanent
}

@Serializable
private data class BatchPayload(val payloads: List<SamsungHealthPayload>)

/**
 * Coroutine-safe webhook client. Uses OkHttp's async [Call.enqueue]
 * API so the dispatching thread is not blocked while the HTTP request
 * is in flight, and propagates cancellation through
 * [suspendCancellableCoroutine].
 *
 * Supports two endpoints:
 *  - `POST /api/webhooks/samsung-health` for a single-day payload.
 *  - `POST /api/webhooks/samsung-health/batch` for a multi-day backfill.
 */
class WebhookClient(
  private val httpClient: OkHttpClient = defaultClient(),
  private val json: Json = Json {
    ignoreUnknownKeys = true
    prettyPrint = false
    encodeDefaults = true
  },
) {

  suspend fun postSamsungHealth(payload: SamsungHealthPayload): WebhookResult {
    if (!SyncConfig.isConfigured()) {
      return WebhookResult.Permanent(
        statusCode = -1,
        message = "SyncConfig is not configured. Update WEBHOOK_URL and SYNC_KEY in BuildConfig fields.",
      )
    }
    val bodyJson = json.encodeToString(payload)
    return executeJsonPost(SyncConfig.webhookUrl, bodyJson)
  }

  suspend fun postSamsungHealthBatch(payloads: List<SamsungHealthPayload>): WebhookResult {
    if (payloads.isEmpty()) {
      return WebhookResult.Permanent(
        statusCode = -1,
        message = "Batch payload is empty",
      )
    }
    if (!SyncConfig.isConfigured()) {
      return WebhookResult.Permanent(
        statusCode = -1,
        message = "SyncConfig is not configured. Update WEBHOOK_URL and SYNC_KEY in BuildConfig fields.",
      )
    }
    val bodyJson = json.encodeToString(BatchPayload(payloads))
    return executeJsonPost(SyncConfig.batchWebhookUrl, bodyJson)
  }

  private suspend fun executeJsonPost(url: String, bodyJson: String): WebhookResult {
    val body = bodyJson.toRequestBody(JSON_MEDIA_TYPE)
    val request = Request.Builder()
      .url(url)
      .header("Content-Type", "application/json")
      .header("x-sync-key", SyncConfig.syncKey)
      .post(body)
      .build()

    return suspendCancellableCoroutine { cont ->
      val call = httpClient.newCall(request)
      cont.invokeOnCancellation { runCatching { call.cancel() } }
      call.enqueue(
        object : Callback {
          override fun onFailure(call: Call, e: IOException) {
            // Network-level failures are always retryable — the server
            // never saw the request.
            if (cont.isActive) {
              cont.resume(
                WebhookResult.Retryable(
                  statusCode = -1,
                  message = e.message ?: e.javaClass.simpleName,
                ),
              )
            }
          }

          override fun onResponse(call: Call, response: Response) {
            response.use { resp ->
              val code = resp.code
              val responseBody = resp.body?.string().orEmpty()
              if (!cont.isActive) return
              val result = when {
                resp.isSuccessful -> WebhookResult.Success(code, responseBody)
                code in RETRYABLE_STATUS -> WebhookResult.Retryable(code, responseBody.take(500))
                // 4xx that isn't 408/429 is a client error and will
                // not improve with a retry — treat as permanent.
                code in 400..499 -> WebhookResult.Permanent(code, responseBody.take(500))
                else -> WebhookResult.Retryable(code, responseBody.take(500))
              }
              cont.resume(result)
            }
          }
        },
      )
    }
  }

  companion object {
    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

    /** HTTP statuses that indicate a transient failure worth retrying. */
    private val RETRYABLE_STATUS = setOf(408, 429, 500, 502, 503, 504)

    private fun defaultClient(): OkHttpClient {
      return OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()
    }
  }
}
