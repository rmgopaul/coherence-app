package com.coherence.healthconnect.auth

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.util.Base64
import android.util.Log
import androidx.browser.customtabs.CustomTabsIntent
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.coherence.healthconnect.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

class AuthManager(private val context: Context) {

  companion object {
    private const val TAG = "AuthManager"
    private const val PREFS_FILE = "coherence_auth"
    private const val KEY_SESSION_TOKEN = "session_token"
    private const val KEY_PIN_COOKIE = "pin_cookie"
    private const val COOKIE_NAME = "app_session_id"
    private const val PIN_COOKIE_NAME = "coherence_pin_gate"
  }

  private val json = Json { ignoreUnknownKeys = true }

  private val masterKey = MasterKey.Builder(context)
    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
    .build()

  // EncryptedSharedPreferences.create() can throw GeneralSecurityException
  // / AEADBadTagException when the on-disk encrypted prefs and the
  // Android Keystore master key get out of sync. The classic trigger
  // is uninstall+reinstall: the Keystore master key sometimes
  // survives the package wipe (it's tied to the keystore alias) but
  // the encrypted file in /data/data/<pkg>/shared_prefs is gone, so
  // Tink can't decrypt and crashes the app boot. The workaround is
  // to wipe the prefs + master key and retry — the user is logged
  // out, but the app survives. Catching is safer than crash-looping
  // because the user has no way to recover without clearing storage.
  private val prefs: SharedPreferences = run {
    try {
      buildEncryptedPrefs()
    } catch (e: Throwable) {
      Log.w(TAG, "EncryptedSharedPreferences create failed; resetting and retrying", e)
      context.deleteSharedPreferences(PREFS_FILE)
      runCatching {
        val keystore = java.security.KeyStore.getInstance("AndroidKeyStore")
        keystore.load(null)
        // Default alias from `MasterKey.Builder` when no alias is set
        keystore.deleteEntry("_androidx_security_master_key_")
      }
      buildEncryptedPrefs()
    }
  }

  private fun buildEncryptedPrefs(): SharedPreferences =
    EncryptedSharedPreferences.create(
      context,
      PREFS_FILE,
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

  private val httpClient = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(10, TimeUnit.SECONDS)
    .build()

  private val _isAuthenticated = MutableStateFlow(getSessionToken() != null)
  val isAuthenticated: StateFlow<Boolean> = _isAuthenticated.asStateFlow()

  private val _isPinUnlocked = MutableStateFlow<Boolean?>(null)
  val isPinUnlocked: StateFlow<Boolean?> = _isPinUnlocked.asStateFlow()

  fun getSessionToken(): String? = prefs.getString(KEY_SESSION_TOKEN, null)

  fun getPinCookie(): String? = prefs.getString(KEY_PIN_COOKIE, null)

  fun saveSessionToken(token: String) {
    prefs.edit().putString(KEY_SESSION_TOKEN, token).apply()
    _isAuthenticated.value = true
  }

  fun savePinCookie(cookie: String) {
    prefs.edit().putString(KEY_PIN_COOKIE, cookie).apply()
    _isPinUnlocked.value = true
  }

  fun clearSession() {
    prefs.edit()
      .remove(KEY_SESSION_TOKEN)
      .remove(KEY_PIN_COOKIE)
      .apply()
    _isAuthenticated.value = false
    _isPinUnlocked.value = null
  }

  /**
   * Launch the Google OAuth flow in Chrome Custom Tabs.
   * The server will redirect back to coherence://auth-callback?token=...
   */
  fun launchLogin(activity: Activity) {
    val loginUrl = buildGoogleOAuthUrl()
    val customTabsIntent = CustomTabsIntent.Builder().build()
    customTabsIntent.launchUrl(activity, Uri.parse(loginUrl))
  }

  /**
   * Build the Google OAuth URL with Android platform indicator in state.
   */
  private fun buildGoogleOAuthUrl(): String {
    val clientId = BuildConfig.GOOGLE_CLIENT_ID
    val baseUrl = baseUrl()
    val redirectUri = "$baseUrl/api/oauth/callback"
    val stateJson = """{"r":"$redirectUri","p":"android"}"""
    val state = Base64.encodeToString(stateJson.toByteArray(), Base64.NO_WRAP)

    return Uri.parse("https://accounts.google.com/o/oauth2/v2/auth").buildUpon()
      .appendQueryParameter("client_id", clientId)
      .appendQueryParameter("redirect_uri", redirectUri)
      .appendQueryParameter("response_type", "code")
      .appendQueryParameter("scope", "openid email profile")
      .appendQueryParameter("state", state)
      .appendQueryParameter("access_type", "offline")
      // `select_account` forces Google to show the account picker
      // even when Chrome has a single signed-in account, so users
      // with multiple Google accounts on the device can choose.
      // `consent` keeps re-prompting for scope grants so we always
      // receive a refresh token alongside access_type=offline.
      .appendQueryParameter("prompt", "select_account consent")
      .build()
      .toString()
  }

  /**
   * Check PIN status. If PIN is not enabled or already unlocked,
   * try direct API access to see if we can skip login entirely.
   */
  suspend fun checkPinStatus() {
    val storedPinCookie = getPinCookie()

    if (storedPinCookie != null && storedPinCookie.isNotBlank()) {
      try {
        val result = withContext(Dispatchers.IO) {
          val request = Request.Builder()
            .url("${baseUrl()}/api/pin/status")
            .addHeader("Cookie", "$PIN_COOKIE_NAME=$storedPinCookie")
            .build()
          val response = httpClient.newCall(request).execute()
          val body = response.body?.string() ?: ""
          val parsed = json.parseToJsonElement(body).jsonObject
          Pair(
            parsed["enabled"]?.jsonPrimitive?.boolean ?: false,
            parsed["unlocked"]?.jsonPrimitive?.boolean ?: true,
          )
        }

        if (!result.first || result.second) {
          savePinCookie(storedPinCookie)
          _isPinUnlocked.value = true
          tryDirectApiAccess()
        } else {
          _isPinUnlocked.value = false
        }
      } catch (e: Exception) {
        Log.w(TAG, "PIN status check failed, trusting stored cookie", e)
        _isPinUnlocked.value = true
      }
      return
    }

    try {
      val enabled = withContext(Dispatchers.IO) {
        val request = Request.Builder()
          .url("${baseUrl()}/api/pin/status")
          .build()
        val response = httpClient.newCall(request).execute()
        val body = response.body?.string() ?: ""
        val parsed = json.parseToJsonElement(body).jsonObject
        parsed["enabled"]?.jsonPrimitive?.boolean ?: false
      }

      _isPinUnlocked.value = !enabled
      if (!enabled) {
        tryDirectApiAccess()
      }
    } catch (e: Exception) {
      Log.w(TAG, "PIN status check failed", e)
      _isPinUnlocked.value = true
    }
  }

  /**
   * If we have a stored session token, verify it's still valid by calling auth.me.
   */
  suspend fun tryDirectApiAccess() {
    if (_isAuthenticated.value) return

    try {
      val statusCode = withContext(Dispatchers.IO) {
        val cookies = buildList {
          getSessionToken()?.let { add("$COOKIE_NAME=$it") }
          getPinCookie()?.let { add("$PIN_COOKIE_NAME=$it") }
        }.joinToString("; ")

        val request = Request.Builder()
          .url("${baseUrl()}/api/trpc/auth.me?input=%7B%22json%22%3Anull%7D")
          .get()
          .apply { if (cookies.isNotBlank()) addHeader("Cookie", cookies) }
          .build()

        val response = httpClient.newCall(request).execute()
        Log.d(TAG, "Direct API check: HTTP ${response.code}")
        response.code
      }

      if (statusCode == 200) {
        _isAuthenticated.value = true
        Log.d(TAG, "Existing session still valid")
      }
    } catch (e: Exception) {
      Log.w(TAG, "Direct API check failed: ${e.message}")
    }
  }

  private fun baseUrl() = BuildConfig.BASE_URL.trimEnd('/')
}
