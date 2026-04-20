package com.coherence.healthconnect.data.repository

import android.util.Log
import com.coherence.healthconnect.data.model.ChatMessage
import com.coherence.healthconnect.data.model.ChatReply
import com.coherence.healthconnect.data.model.Conversation
import com.coherence.healthconnect.data.model.ConversationCreateResult
import com.coherence.healthconnect.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put

class ChatRepository(private val trpc: TrpcClient, private val json: Json) {

  companion object {
    private const val TAG = "ChatRepository"
  }

  suspend fun listConversations(limit: Int = 100): List<Conversation> {
    val input = buildJsonObject { put("limit", limit) }
    return try {
      val result = trpc.query("conversations.listSummaries", input)
      result.jsonArray.map { json.decodeFromJsonElement(Conversation.serializer(), it) }
    } catch (e: Exception) {
      Log.w(TAG, "listConversations failed", e)
      // Backward-compatible fallback if the summaries endpoint is unavailable.
      val result = trpc.query("conversations.list")
      result.jsonArray.map { json.decodeFromJsonElement(Conversation.serializer(), it) }
    }
  }

  suspend fun createConversation(title: String): String? {
    return try {
      val input = buildJsonObject { put("title", title) }
      val result = trpc.mutate("conversations.create", input)
      json.decodeFromJsonElement(ConversationCreateResult.serializer(), result).id
    } catch (e: Exception) {
      Log.w(TAG, "createConversation failed", e)
      null
    }
  }

  suspend fun getMessages(conversationId: String): List<ChatMessage> {
    val input = buildJsonObject { put("conversationId", conversationId) }
    val result = trpc.query("conversations.getMessages", input)
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(ChatMessage.serializer(), it) }
    } catch (e: Exception) {
      Log.w(TAG, "getMessages failed", e)
      emptyList()
    }
  }

  suspend fun deleteConversation(conversationId: String): Boolean {
    return try {
      val input = buildJsonObject { put("conversationId", conversationId) }
      trpc.mutate("conversations.delete", input)
      true
    } catch (e: Exception) {
      Log.w(TAG, "deleteConversation failed", e)
      false
    }
  }

  suspend fun sendMessage(conversationId: String, message: String): String? {
    return try {
      val input = buildJsonObject {
        put("conversationId", conversationId)
        put("message", message)
      }
      val result = trpc.mutate("openai.chat", input)
      json.decodeFromJsonElement(ChatReply.serializer(), result).reply
    } catch (e: Exception) {
      Log.w(TAG, "sendMessage failed", e)
      null
    }
  }
}
