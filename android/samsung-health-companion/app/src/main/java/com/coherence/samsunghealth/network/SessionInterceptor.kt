package com.coherence.samsunghealth.network

import com.coherence.samsunghealth.auth.AuthManager
import okhttp3.Interceptor
import okhttp3.Response

class SessionInterceptor(
  private val authManager: AuthManager,
) : Interceptor {

  override fun intercept(chain: Interceptor.Chain): Response {
    val original = chain.request()
    val token = authManager.getSessionToken()

    val cookies = buildList {
      if (token != null) add("app_session_id=$token")
      val pinCookie = authManager.getPinCookie()
      if (pinCookie != null) add("coherence_pin_gate=$pinCookie")
    }

    val request = if (cookies.isNotEmpty()) {
      original.newBuilder()
        .header("Cookie", cookies.joinToString("; "))
        .build()
    } else {
      original
    }

    return chain.proceed(request)
  }
}
