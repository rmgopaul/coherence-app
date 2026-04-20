package com.coherence.healthconnect.data.model

import kotlinx.serialization.Serializable

@Serializable
data class Conversation(
  val id: String,
  val userId: Int? = null,
  val title: String,
  val lastMessagePreview: String? = null,
  val lastMessageAt: String? = null,
  val messageCount: Int? = null,
  val createdAt: String? = null,
  val updatedAt: String? = null,
)

@Serializable
data class ChatMessage(
  val id: String,
  val conversationId: String,
  val role: String, // "user" or "assistant"
  val content: String,
  val createdAt: String? = null,
)

@Serializable
data class DailyOverview(
  val overview: String,
)

@Serializable
data class ChatReply(
  val reply: String,
)

@Serializable
data class ConversationCreateResult(
  val id: String,
)
