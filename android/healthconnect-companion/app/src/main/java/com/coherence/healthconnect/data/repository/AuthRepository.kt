package com.coherence.healthconnect.data.repository

import android.util.Log
import com.coherence.healthconnect.data.model.Integration
import com.coherence.healthconnect.data.model.User
import com.coherence.healthconnect.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray

class AuthRepository(private val trpc: TrpcClient, private val json: Json) {

  companion object {
    private const val TAG = "AuthRepository"
  }

  suspend fun getMe(): User? {
    val result = trpc.query("auth.me")
    return try {
      json.decodeFromJsonElement(User.serializer(), result)
    } catch (e: Exception) {
      Log.w(TAG, "getMe failed", e)
      null
    }
  }

  suspend fun getIntegrations(): List<Integration> {
    val result = trpc.query("integrations.list")
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(Integration.serializer(), it) }
    } catch (e: Exception) {
      Log.w(TAG, "getIntegrations failed", e)
      emptyList()
    }
  }
}
