package com.coherence.samsunghealth.auth

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import android.webkit.CookieManager
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.coherence.samsunghealth.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class AuthManager(private val context: Context) {

  companion object {
    private const val TAG = "AuthManager"
    private const val PREFS_FILE = "coherence_auth"
    private const val KEY_SESSION_TOKEN = "session_token"
    private const val KEY_PIN_COOKIE = "pin_cookie"
    private const val KEY_AUTH_BYPASS = "auth_bypass"
    private const val COOKIE_NAME = "app_session_id"
    private const val PIN_COOKIE_NAME = "coherence_pin_gate"
  }

  private val json = Json { ignoreUnknownKeys = true }

  private val masterKey = MasterKey.Builder(context)
    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
    .build()

  private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
    context,
    PREFS_FILE,
    masterKey,
    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
  )

  private val _isAuthenticated = MutableStateFlow(
    getSessionToken() != null || prefs.getBoolean(KEY_AUTH_BYPASS, false),
  )
  val isAuthenticated: StateFlow<Boolean> = _isAuthenticated.asStateFlow()

  // PIN state: null = unknown, true = unlocked/not needed, false = locked
  private val _isPinUnlocked = MutableStateFlow<Boolean?>(null)
  val isPinUnlocked: StateFlow<Boolean?> = _isPinUnlocked.asStateFlow()

  fun getSessionToken(): String? {
    return prefs.getString(KEY_SESSION_TOKEN, null)
  }

  fun getPinCookie(): String? {
    return prefs.getString(KEY_PIN_COOKIE, null)
  }

  fun saveSessionToken(token: String) {
    prefs.edit().putString(KEY_SESSION_TOKEN, token).apply()
    _isAuthenticated.value = true
  }

  /**
   * Mark as authenticated even without a session cookie.
   * Used when server has DEV_BYPASS_AUTH=true and API works with just PIN cookie.
   */
  private fun markAuthBypassed() {
    prefs.edit().putBoolean(KEY_AUTH_BYPASS, true).apply()
    _isAuthenticated.value = true
    Log.d(TAG, "Auth bypassed — API accessible without session cookie")
  }

  fun savePinCookie(cookie: String) {
    prefs.edit().putString(KEY_PIN_COOKIE, cookie).apply()
    _isPinUnlocked.value = true

    // Also set the PIN cookie in WebView's CookieManager
    val cookieManager = CookieManager.getInstance()
    val baseUrl = BuildConfig.BASE_URL
    cookieManager.setCookie(baseUrl, "$PIN_COOKIE_NAME=$cookie; path=/; secure; httponly")
    cookieManager.flush()
  }

  fun clearSession() {
    prefs.edit()
      .remove(KEY_SESSION_TOKEN)
      .remove(KEY_PIN_COOKIE)
      .remove(KEY_AUTH_BYPASS)
      .apply()
    _isAuthenticated.value = false
    _isPinUnlocked.value = null
    CookieManager.getInstance().removeAllCookies(null)
  }

  /**
   * Check PIN status and, if PIN is already unlocked, try to access API directly.
   * If the API is accessible (server has DEV_BYPASS_AUTH), skip the WebView login entirely.
   */
  suspend fun checkPinStatus() {
    val storedPinCookie = getPinCookie()

    if (storedPinCookie != null && storedPinCookie.isNotBlank()) {
      // We have a stored PIN cookie — verify it's still valid
      try {
        val result = withContext(Dispatchers.IO) {
          val client = buildClient()
          val request = Request.Builder()
            .url("${baseUrl()}/api/pin/status")
            .addHeader("Cookie", "$PIN_COOKIE_NAME=$storedPinCookie")
            .build()
          val response = client.newCall(request).execute()
          val body = response.body?.string() ?: ""
          val parsed = json.parseToJsonElement(body).jsonObject
          Pair(
            parsed["enabled"]?.jsonPrimitive?.boolean ?: false,
            parsed["unlocked"]?.jsonPrimitive?.boolean ?: true,
          )
        }

        if (!result.first || result.second) {
          // PIN not enabled or our cookie is valid
          savePinCookie(storedPinCookie)
          _isPinUnlocked.value = true
          // Now try accessing the API to see if we can skip login
          tryDirectApiAccess()
        } else {
          _isPinUnlocked.value = false
        }
      } catch (_: Exception) {
        // Network error — trust stored cookie
        _isPinUnlocked.value = true
      }
      return
    }

    // No stored PIN cookie — check if PIN is even enabled
    try {
      val enabled = withContext(Dispatchers.IO) {
        val client = buildClient()
        val request = Request.Builder()
          .url("${baseUrl()}/api/pin/status")
          .build()
        val response = client.newCall(request).execute()
        val body = response.body?.string() ?: ""
        val parsed = json.parseToJsonElement(body).jsonObject
        parsed["enabled"]?.jsonPrimitive?.boolean ?: false
      }

      _isPinUnlocked.value = !enabled
      if (!enabled) {
        // No PIN needed — try direct API access
        tryDirectApiAccess()
      }
    } catch (_: Exception) {
      _isPinUnlocked.value = true
    }
  }

  /**
   * After PIN is unlocked, try calling a tRPC endpoint directly.
   * If it succeeds, the server has DEV_BYPASS_AUTH or the user is already
   * authenticated — either way, we can skip the WebView login.
   */
  suspend fun tryDirectApiAccess() {
    if (_isAuthenticated.value) return // already authenticated

    try {
      val statusCode = withContext(Dispatchers.IO) {
        val client = buildClient()
        val cookies = buildList {
          getSessionToken()?.let { add("$COOKIE_NAME=$it") }
          getPinCookie()?.let { add("$PIN_COOKIE_NAME=$it") }
        }.joinToString("; ")

        // tRPC queries use GET with ?input= query param
        val request = Request.Builder()
          .url("${baseUrl()}/api/trpc/auth.me?input=%7B%22json%22%3Anull%7D")
          .get()
          .apply { if (cookies.isNotBlank()) addHeader("Cookie", cookies) }
          .build()

        val response = client.newCall(request).execute()
        val responseBody = response.body?.string()
        Log.d(TAG, "Direct API response: HTTP ${response.code}, body: ${responseBody?.take(200)}")
        response.code
      }

      Log.d(TAG, "Direct API access check: HTTP $statusCode")

      when (statusCode) {
        200 -> markAuthBypassed() // API works — no login needed
        401 -> {} // Need real auth — will show WebView
        423 -> {} // PIN not working — shouldn't happen here
      }
    } catch (e: Exception) {
      Log.w(TAG, "Direct API check failed: ${e.message}")
    }
  }

  fun tryExtractSessionCookie(): Boolean {
    val cookieManager = CookieManager.getInstance()
    val baseUrl = BuildConfig.BASE_URL
    val cookies = cookieManager.getCookie(baseUrl) ?: return false

    val sessionToken = cookies.split(";")
      .map { it.trim() }
      .firstOrNull { it.startsWith("$COOKIE_NAME=") }
      ?.substringAfter("$COOKIE_NAME=")

    if (sessionToken != null && sessionToken.isNotBlank()) {
      saveSessionToken(sessionToken)
      return true
    }
    return false
  }

  fun getLoginUrl(): String {
    return BuildConfig.BASE_URL
  }

  private fun baseUrl() = BuildConfig.BASE_URL.trimEnd('/')

  private fun buildClient() = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(10, TimeUnit.SECONDS)
    .build()
}
