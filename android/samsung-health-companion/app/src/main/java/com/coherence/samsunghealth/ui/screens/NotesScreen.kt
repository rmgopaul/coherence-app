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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.data.model.Note
import com.coherence.samsunghealth.ui.LocalApp
import com.coherence.samsunghealth.ui.widgets.RichText
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private fun stripHtml(html: String): String =
  html.replace(Regex("<[^>]+>"), " ").replace(Regex("\\s+"), " ").trim()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotesScreen(onBack: () -> Unit) {
  val app = LocalApp.current
  val repo = app.container.notesRepository
  val scope = rememberCoroutineScope()

  val notes = remember { mutableStateListOf<Note>() }
  var selectedNote by remember { mutableStateOf<Note?>(null) }
  var isLoading by remember { mutableStateOf(true) }

  LaunchedEffect(Unit) {
    notes.addAll(repo.list())
    isLoading = false
  }

  if (selectedNote != null) {
    NoteEditorView(
      note = selectedNote!!,
      onBack = {
        selectedNote = null
        scope.launch {
          notes.clear()
          notes.addAll(repo.list())
        }
      },
      onSave = { title, content ->
        scope.launch {
          repo.update(selectedNote!!.id, title = title, content = content)
        }
      },
    )
  } else {
    Scaffold(
      topBar = {
        TopAppBar(
          title = { Text("Notes") },
          navigationIcon = {
            IconButton(onClick = onBack) {
              Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
          },
        )
      },
      floatingActionButton = {
        FloatingActionButton(
          onClick = {
            scope.launch {
              val id = repo.create("Untitled Note")
              if (id != null) {
                val newNote = Note(id = id, title = "Untitled Note")
                notes.add(0, newNote)
                selectedNote = newNote
              }
            }
          },
        ) {
          Icon(Icons.Default.Add, contentDescription = "New Note")
        }
      },
    ) { padding ->
      if (isLoading) {
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
          Text("Loading notes...")
        }
      } else if (notes.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
          Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.AutoMirrored.Filled.Notes, contentDescription = null, modifier = Modifier.size(48.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            Text("No notes yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
      } else {
        LazyColumn(
          modifier = Modifier.padding(padding),
          contentPadding = PaddingValues(16.dp),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          val pinned = notes.filter { it.pinned }
          val unpinned = notes.filter { !it.pinned }

          if (pinned.isNotEmpty()) {
            item { Text("Pinned", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary) }
            items(pinned) { note -> NoteListItem(note, onClick = { selectedNote = note }, onDelete = { scope.launch { repo.delete(note.id); notes.remove(note) } }) }
          }

          if (unpinned.isNotEmpty()) {
            if (pinned.isNotEmpty()) item { Spacer(Modifier.height(8.dp)) }
            items(unpinned) { note -> NoteListItem(note, onClick = { selectedNote = note }, onDelete = { scope.launch { repo.delete(note.id); notes.remove(note) } }) }
          }
        }
      }
    }
  }
}

@Composable
private fun NoteListItem(note: Note, onClick: () -> Unit, onDelete: () -> Unit) {
  Card(
    modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(16.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      if (note.pinned) {
        Icon(Icons.Default.PushPin, contentDescription = "Pinned", modifier = Modifier.size(16.dp).padding(end = 8.dp), tint = MaterialTheme.colorScheme.primary)
      }
      Column(modifier = Modifier.weight(1f)) {
        Text(note.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (note.content.isNotBlank()) {
          Text(
            stripHtml(note.content).take(100),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
        }
        Text(note.notebook, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      IconButton(onClick = onDelete, modifier = Modifier.size(32.dp)) {
        Icon(Icons.Default.Delete, contentDescription = "Delete", modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NoteEditorView(
  note: Note,
  onBack: () -> Unit,
  onSave: (String, String) -> Unit,
) {
  var title by remember { mutableStateOf(note.title) }
  var content by remember { mutableStateOf(note.content) }
  var isDirty by remember { mutableStateOf(false) }
  var isEditing by remember { mutableStateOf(false) }

  // Auto-save with debounce
  LaunchedEffect(title, content) {
    if (isDirty) {
      delay(1500)
      onSave(title, content)
    }
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text(if (isEditing) "Edit Note" else note.title.ifBlank { "Note" }) },
        navigationIcon = {
          IconButton(onClick = {
            if (isEditing) {
              isEditing = false
            } else {
              if (isDirty) onSave(title, content)
              onBack()
            }
          }) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
          }
        },
        actions = {
          IconButton(onClick = { isEditing = !isEditing }) {
            Icon(
              if (isEditing) Icons.Default.Visibility else Icons.Default.Edit,
              contentDescription = if (isEditing) "Preview" else "Edit",
            )
          }
        },
      )
    },
  ) { padding ->
    if (isEditing) {
      Column(
        modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp).imePadding(),
      ) {
        OutlinedTextField(
          value = title,
          onValueChange = { title = it; isDirty = true },
          modifier = Modifier.fillMaxWidth(),
          label = { Text("Title") },
          singleLine = true,
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
          value = content,
          onValueChange = { content = it; isDirty = true },
          modifier = Modifier.fillMaxSize().weight(1f),
          label = { Text("Content") },
        )
      }
    } else {
      // Rendered rich text view
      Column(
        modifier = Modifier
          .fillMaxSize()
          .padding(padding)
          .padding(16.dp)
          .verticalScroll(rememberScrollState()),
      ) {
        Text(
          text = title,
          style = MaterialTheme.typography.headlineSmall,
          fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(16.dp))
        if (content.isNotBlank()) {
          RichText(text = content)
        } else {
          Text(
            "Tap the edit icon to start writing...",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      }
    }
  }
}
