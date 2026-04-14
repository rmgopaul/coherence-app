package com.coherence.samsunghealth.network

import android.util.Log
import com.coherence.samsunghealth.BuildConfig
import com.coherence.samsunghealth.auth.AuthManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class TrpcClient(authManager: AuthManager, private val json: Json) {

  private val client: OkHttpClient = OkHttpClient.Builder()
    .addInterceptor(SessionInterceptor(authManager))
    .addInterceptor(HttpLoggingInterceptor().apply {
      level = HttpLoggingInterceptor.Level.BASIC
    })
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(90, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS)
    .build()

  private val baseUrl = BuildConfig.BASE_URL.trimEnd('/')

  /**
   * tRPC query — uses GET with ?input= query parameter.
   */
  suspend fun query(procedure: String, input: JsonElement? = null): JsonElement =
    withContext(Dispatchers.IO) {
      val url = if (input != null) {
        val inputObj = buildJsonObject { put("json", input) }
        val encoded = URLEncoder.encode(inputObj.toString(), "UTF-8")
        "$baseUrl/api/trpc/$procedure?input=$encoded"
      } else {
        "$baseUrl/api/trpc/$procedure"
      }

      val request = Request.Builder()
        .url(url)
        .get()
        .build()

      executeAndDecode(procedure, request)
    }

  /**
   * tRPC mutation — uses POST with JSON body.
   */
  suspend fun mutate(procedure: String, input: JsonElement? = null): JsonElement =
    withContext(Dispatchers.IO) {
      val body = buildJsonObject {
        put("json", input ?: JsonNull)
      }

      val request = Request.Builder()
        .url("$baseUrl/api/trpc/$procedure")
        .post(body.toString().toRequestBody("application/json".toMediaType()))
        .build()

      executeAndDecode(procedure, request)
    }

  private fun executeAndDecode(procedure: String, request: Request): JsonElement {
    val response = client.newCall(request).execute()
    val responseBody = response.body?.string()
      ?: throw TrpcException(response.code, "Empty response body")

    if (!response.isSuccessful) {
      Log.w("TrpcClient", "[$procedure] HTTP ${response.code}")
      when (response.code) {
        401 -> throw TrpcUnauthorizedException()
        423 -> throw TrpcPinRequiredException()
        else -> throw TrpcException(response.code, responseBody)
      }
    }

    val parsed = json.parseToJsonElement(responseBody)
    return SuperJsonDecoder.decodeTrpcResult(parsed)
  }
}

open class TrpcException(val statusCode: Int, message: String) : Exception(message)
class TrpcUnauthorizedException : TrpcException(401, "Unauthorized")
class TrpcPinRequiredException : TrpcException(423, "PIN required")
