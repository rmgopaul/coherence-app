package com.coherence.samsunghealth.ui.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.MarkEmailRead
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.data.model.GmailMessage

@Composable
fun GmailWidget(
  messages: List<GmailMessage>,
  isLoading: Boolean,
  onMarkRead: (String) -> Unit,
  maxItems: Int = 6,
) {
  WidgetShell(title = "Gmail", icon = Icons.Default.Email, category = WidgetCategory.PRODUCTIVITY, isLoading = isLoading && messages.isEmpty()) {
    if (isLoading && messages.isEmpty()) {
      Text(
        "Loading emails...",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else if (messages.isEmpty()) {
      Text(
        "No messages",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else {
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        messages.take(maxItems).forEach { msg ->
          GmailMessageRow(msg, onMarkRead)
        }
        if (messages.size > maxItems) {
          Text(
            "+${messages.size - maxItems} more",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 16.dp, top = 4.dp),
          )
        }
      }
    }
  }
}

@Composable
private fun GmailMessageRow(
  message: GmailMessage,
  onMarkRead: (String) -> Unit,
) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .padding(vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    if (message.isUnread) {
      Icon(
        Icons.Default.FiberManualRecord,
        contentDescription = "Unread",
        modifier = Modifier.size(8.dp),
        tint = MaterialTheme.colorScheme.primary,
      )
    } else {
      Spacer(modifier = Modifier.size(8.dp))
    }

    Spacer(modifier = Modifier.width(8.dp))

    Column(modifier = Modifier.weight(1f)) {
      Text(
        text = message.from.substringBefore("<").trim().ifBlank { message.from },
        style = MaterialTheme.typography.labelMedium,
        fontWeight = if (message.isUnread) FontWeight.Bold else FontWeight.Normal,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Text(
        text = message.subject,
        style = MaterialTheme.typography.bodySmall,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      if (message.snippet.isNotBlank()) {
        Text(
          text = message.snippet,
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }

    if (message.isUnread) {
      IconButton(
        onClick = { onMarkRead(message.id) },
        modifier = Modifier.size(32.dp),
      ) {
        Icon(
          Icons.Default.MarkEmailRead,
          contentDescription = "Mark as read",
          modifier = Modifier.size(18.dp),
          tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }
  }
}
