package com.coherence.samsunghealth.ui.screens

import android.graphics.Bitmap
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.coherence.samsunghealth.BuildConfig
import com.coherence.samsunghealth.auth.AuthManager

@Composable
fun LoginScreen(authManager: AuthManager) {
  var isLoading by remember { mutableStateOf(true) }
  var pageTitle by remember { mutableStateOf("Sign In") }

  Column(modifier = Modifier.fillMaxSize()) {
    // Header
    Box(
      modifier = Modifier
        .fillMaxWidth()
        .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
      Text(
        text = pageTitle,
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.align(Alignment.Center),
      )
    }

    // Loading indicator
    if (isLoading) {
      LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
    }

    // WebView for OAuth login
    AndroidView(
      factory = { context ->
        WebView(context).apply {
          // Enable cookies so we can capture app_session_id
          val cookieManager = CookieManager.getInstance()
          cookieManager.setAcceptCookie(true)
          cookieManager.setAcceptThirdPartyCookies(this, true)

          settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
          }

          webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView?, title: String?) {
              if (title != null && !title.startsWith("http")) {
                pageTitle = title
              }
            }
          }

          webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
              isLoading = true
              // Check cookie on every page start too
              tryCaptureSession(authManager, url)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
              isLoading = false
              // Check cookie after page finishes loading
              tryCaptureSession(authManager, url)
            }

            override fun onReceivedHttpError(
              view: WebView?,
              request: WebResourceRequest?,
              errorResponse: WebResourceResponse?,
            ) {
              // Also check on HTTP responses (the /api/oauth/callback sets cookie via redirect)
              tryCaptureSession(authManager, request?.url?.toString())
            }

            override fun shouldOverrideUrlLoading(
              view: WebView?,
              request: WebResourceRequest?,
            ): Boolean {
              val url = request?.url?.toString() ?: return false
              // Check cookie on every navigation — especially the OAuth callback redirect
              tryCaptureSession(authManager, url)
              return false
            }
          }

          loadUrl(authManager.getLoginUrl())
        }
      },
      modifier = Modifier.fillMaxSize(),
    )
  }
}

private fun tryCaptureSession(authManager: AuthManager, url: String?) {
  val baseUrl = BuildConfig.BASE_URL.trimEnd('/')
  // Flush cookies to ensure they're persisted before reading
  CookieManager.getInstance().flush()

  val cookies = CookieManager.getInstance().getCookie(baseUrl)
  Log.d("LoginScreen", "URL: $url | Cookies for $baseUrl: $cookies")

  if (authManager.tryExtractSessionCookie()) {
    Log.d("LoginScreen", "Session cookie captured! Transitioning to native app.")
  }
}
