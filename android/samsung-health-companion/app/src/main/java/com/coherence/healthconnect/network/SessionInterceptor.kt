package com.coherence.healthconnect.network

import android.util.Log
import com.coherence.healthconnect.auth.AuthManager
import okhttp3.Interceptor
import okhttp3.Response

class SessionInterceptor(
  private val authManager: AuthManager,
) : Interceptor {

  override fun intercept(chain: Interceptor.Chain): Response {
    val original = chain.request()

    val cookies = buildList {
      authManager.getSessionToken()?.let { add("app_session_id=$it") }
      authManager.getPinCookie()?.let { add("coherence_pin_gate=$it") }
    }

    val request = if (cookies.isNotEmpty()) {
      original.newBuilder()
        .header("Cookie", cookies.joinToString("; "))
        .build()
    } else {
      original
    }

    val response = chain.proceed(request)

    // If the server returns 401, clear the session so the UI redirects to login
    if (response.code == 401) {
      Log.w("SessionInterceptor", "Received 401 — clearing session")
      authManager.clearSession()
    }

    return response
  }
}
