package com.coherence.samsunghealth.data.repository

import com.coherence.samsunghealth.data.model.ChatMessage
import com.coherence.samsunghealth.data.model.ChatReply
import com.coherence.samsunghealth.data.model.Conversation
import com.coherence.samsunghealth.data.model.ConversationCreateResult
import com.coherence.samsunghealth.network.TrpcClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put

class ChatRepository(private val trpc: TrpcClient) {

  private val json = Json { ignoreUnknownKeys = true }

  suspend fun listConversations(): List<Conversation> {
    val result = trpc.query("conversations.list")
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(Conversation.serializer(), it) }
    } catch (_: Exception) {
      emptyList()
    }
  }

  suspend fun createConversation(title: String): String? {
    return try {
      val input = buildJsonObject { put("title", title) }
      val result = trpc.mutate("conversations.create", input)
      json.decodeFromJsonElement(ConversationCreateResult.serializer(), result).id
    } catch (_: Exception) {
      null
    }
  }

  suspend fun getMessages(conversationId: String): List<ChatMessage> {
    val input = buildJsonObject { put("conversationId", conversationId) }
    val result = trpc.query("conversations.getMessages", input)
    return try {
      result.jsonArray.map { json.decodeFromJsonElement(ChatMessage.serializer(), it) }
    } catch (_: Exception) {
      emptyList()
    }
  }

  suspend fun deleteConversation(conversationId: String): Boolean {
    return try {
      val input = buildJsonObject { put("conversationId", conversationId) }
      trpc.mutate("conversations.delete", input)
      true
    } catch (_: Exception) {
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
    } catch (_: Exception) {
      null
    }
  }
}
