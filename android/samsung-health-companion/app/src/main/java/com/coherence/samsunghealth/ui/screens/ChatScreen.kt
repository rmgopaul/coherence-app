package com.coherence.samsunghealth.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.data.model.ChatMessage
import com.coherence.samsunghealth.data.model.Conversation
import com.coherence.samsunghealth.data.repository.ChatRepository
import com.coherence.samsunghealth.ui.LocalApp
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen() {
  val app = LocalApp.current
  val chatRepo = app.chatRepository
  var selectedConversation by remember { mutableStateOf<Conversation?>(null) }

  if (selectedConversation != null) {
    ChatConversationView(
      conversation = selectedConversation!!,
      chatRepo = chatRepo,
      onBack = { selectedConversation = null },
    )
  } else {
    ChatListView(
      chatRepo = chatRepo,
      onSelectConversation = { selectedConversation = it },
    )
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatListView(
  chatRepo: ChatRepository,
  onSelectConversation: (Conversation) -> Unit,
) {
  val conversations = remember { mutableStateListOf<Conversation>() }
  var isLoading by remember { mutableStateOf(true) }
  val scope = rememberCoroutineScope()

  LaunchedEffect(Unit) {
    conversations.clear()
    conversations.addAll(chatRepo.listConversations())
    isLoading = false
  }

  Scaffold(
    topBar = {
      TopAppBar(title = { Text("Chat") })
    },
    floatingActionButton = {
      FloatingActionButton(
        onClick = {
          scope.launch {
            val id = chatRepo.createConversation("New Chat")
            if (id != null) {
              val newConv = Conversation(id = id, title = "New Chat")
              conversations.add(0, newConv)
              onSelectConversation(newConv)
            }
          }
        },
      ) {
        Icon(Icons.Default.Add, contentDescription = "New Chat")
      }
    },
  ) { padding ->
    if (isLoading) {
      Box(
        modifier = Modifier
          .fillMaxSize()
          .padding(padding),
        contentAlignment = Alignment.Center,
      ) {
        Text("Loading conversations...", color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    } else if (conversations.isEmpty()) {
      Box(
        modifier = Modifier
          .fillMaxSize()
          .padding(padding),
        contentAlignment = Alignment.Center,
      ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
          Icon(
            Icons.Default.Chat,
            contentDescription = null,
            modifier = Modifier.size(48.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          Spacer(modifier = Modifier.height(8.dp))
          Text("No conversations yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
          Text("Tap + to start chatting", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
      }
    } else {
      LazyColumn(
        modifier = Modifier.padding(padding),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        items(conversations) { conversation ->
          Card(
            modifier = Modifier
              .fillMaxWidth()
              .clickable { onSelectConversation(conversation) },
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
          ) {
            Row(
              modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Icon(
                Icons.Default.Chat,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
                tint = MaterialTheme.colorScheme.primary,
              )
              Spacer(modifier = Modifier.width(12.dp))
              Text(
                text = conversation.title,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
              )
              IconButton(
                onClick = {
                  scope.launch {
                    chatRepo.deleteConversation(conversation.id)
                    conversations.remove(conversation)
                  }
                },
                modifier = Modifier.size(32.dp),
              ) {
                Icon(
                  Icons.Default.Delete,
                  contentDescription = "Delete",
                  modifier = Modifier.size(18.dp),
                  tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
              }
            }
          }
        }
      }
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatConversationView(
  conversation: Conversation,
  chatRepo: ChatRepository,
  onBack: () -> Unit,
) {
  val messages = remember { mutableStateListOf<ChatMessage>() }
  var inputText by remember { mutableStateOf("") }
  var isSending by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  val listState = rememberLazyListState()

  LaunchedEffect(conversation.id) {
    messages.clear()
    messages.addAll(chatRepo.getMessages(conversation.id))
  }

  // Scroll to bottom when new messages arrive
  LaunchedEffect(messages.size) {
    if (messages.isNotEmpty()) {
      listState.animateScrollToItem(messages.size - 1)
    }
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text(conversation.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
          }
        },
      )
    },
  ) { padding ->
    Column(
      modifier = Modifier
        .fillMaxSize()
        .padding(padding)
        .imePadding(),
    ) {
      // Messages list
      LazyColumn(
        modifier = Modifier
          .weight(1f)
          .fillMaxWidth(),
        state = listState,
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        items(messages) { message ->
          ChatBubble(message)
        }
        if (isSending) {
          item {
            Text(
              "Thinking...",
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
              modifier = Modifier.padding(start = 8.dp),
            )
          }
        }
      }

      // Input bar
      Row(
        modifier = Modifier
          .fillMaxWidth()
          .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
      ) {
        OutlinedTextField(
          value = inputText,
          onValueChange = { inputText = it },
          modifier = Modifier.weight(1f),
          placeholder = { Text("Type a message...") },
          maxLines = 4,
          shape = RoundedCornerShape(24.dp),
        )
        Spacer(modifier = Modifier.width(8.dp))
        IconButton(
          onClick = {
            if (inputText.isNotBlank() && !isSending) {
              val text = inputText.trim()
              inputText = ""
              isSending = true
              // Add user message locally
              messages.add(
                ChatMessage(
                  id = "local-${System.currentTimeMillis()}",
                  conversationId = conversation.id,
                  role = "user",
                  content = text,
                )
              )
              scope.launch {
                val reply = chatRepo.sendMessage(conversation.id, text)
                if (reply != null) {
                  messages.add(
                    ChatMessage(
                      id = "local-reply-${System.currentTimeMillis()}",
                      conversationId = conversation.id,
                      role = "assistant",
                      content = reply,
                    )
                  )
                }
                isSending = false
              }
            }
          },
          enabled = inputText.isNotBlank() && !isSending,
        ) {
          Icon(
            Icons.AutoMirrored.Filled.Send,
            contentDescription = "Send",
            tint = if (inputText.isNotBlank() && !isSending) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      }
    }
  }
}

@Composable
private fun ChatBubble(message: ChatMessage) {
  val isUser = message.role == "user"

  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
  ) {
    Surface(
      shape = RoundedCornerShape(
        topStart = 16.dp,
        topEnd = 16.dp,
        bottomStart = if (isUser) 16.dp else 4.dp,
        bottomEnd = if (isUser) 4.dp else 16.dp,
      ),
      color = if (isUser) MaterialTheme.colorScheme.primary
      else MaterialTheme.colorScheme.surfaceVariant,
      modifier = Modifier.widthIn(max = 300.dp),
    ) {
      Text(
        text = message.content,
        modifier = Modifier.padding(12.dp),
        color = if (isUser) MaterialTheme.colorScheme.onPrimary
        else MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyMedium,
      )
    }
  }
}
