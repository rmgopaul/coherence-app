package com.coherence.healthconnect.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.GridOn
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Slideshow
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coherence.healthconnect.data.model.DriveFile
import com.coherence.healthconnect.ui.LocalApp
import kotlinx.coroutines.launch

private fun driveFileIcon(mimeType: String): ImageVector = when {
  mimeType.contains("folder") -> Icons.Default.Folder
  mimeType.contains("spreadsheet") || mimeType.contains("excel") -> Icons.Default.GridOn
  mimeType.contains("document") || mimeType.contains("word") -> Icons.Default.Description
  mimeType.contains("presentation") || mimeType.contains("powerpoint") -> Icons.Default.Slideshow
  mimeType.contains("pdf") -> Icons.Default.PictureAsPdf
  mimeType.contains("image") -> Icons.Default.Image
  else -> Icons.Default.InsertDriveFile
}

private fun driveFileColor(mimeType: String): Color = when {
  mimeType.contains("folder") -> Color(0xFF8AB4F8)
  mimeType.contains("spreadsheet") -> Color(0xFF34A853)
  mimeType.contains("document") -> Color(0xFF4285F4)
  mimeType.contains("presentation") -> Color(0xFFFBBC04)
  mimeType.contains("pdf") -> Color(0xFFEA4335)
  mimeType.contains("image") -> Color(0xFFE91E63)
  else -> Color(0xFF9E9E9E)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DriveScreen(onBack: () -> Unit) {
  val app = LocalApp.current
  val repo = app.container.googleRepository
  val scope = rememberCoroutineScope()
  val context = LocalContext.current

  val files = remember { mutableStateListOf<DriveFile>() }
  var isLoading by remember { mutableStateOf(true) }
  var searchQuery by remember { mutableStateOf("") }
  var isSearching by remember { mutableStateOf(false) }

  LaunchedEffect(Unit) {
    try {
      files.addAll(repo.getDriveFiles())
    } catch (_: Exception) {}
    isLoading = false
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Drive Files") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
          }
        },
      )
    },
  ) { padding ->
    Column(
      modifier = Modifier.fillMaxSize().padding(padding),
    ) {
      // Search bar
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        TextField(
          value = searchQuery,
          onValueChange = { searchQuery = it },
          placeholder = { Text("Search Drive...") },
          modifier = Modifier.weight(1f),
          singleLine = true,
        )
        IconButton(
          onClick = {
            if (searchQuery.isNotBlank()) {
              isSearching = true
              scope.launch {
                try {
                  val results = repo.searchDrive(searchQuery)
                  files.clear()
                  files.addAll(results)
                } catch (_: Exception) {}
                isSearching = false
              }
            } else {
              isLoading = true
              scope.launch {
                try {
                  files.clear()
                  files.addAll(repo.getDriveFiles())
                } catch (_: Exception) {}
                isLoading = false
              }
            }
          },
        ) {
          Icon(Icons.Default.Search, contentDescription = "Search")
        }
      }

      if (isLoading || isSearching) {
        Column(
          modifier = Modifier.fillMaxSize(),
          verticalArrangement = Arrangement.Center,
          horizontalAlignment = Alignment.CenterHorizontally,
        ) {
          CircularProgressIndicator()
          Text("Loading...", modifier = Modifier.padding(top = 8.dp))
        }
      } else if (files.isEmpty()) {
        Column(
          modifier = Modifier.fillMaxSize(),
          verticalArrangement = Arrangement.Center,
          horizontalAlignment = Alignment.CenterHorizontally,
        ) {
          Text("No files found", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
      } else {
        LazyColumn(
          contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
          verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          items(files.filter { !it.trashed }) { file ->
            DriveFileRow(file = file) {
              file.webViewLink?.let { link ->
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)))
              }
            }
          }
        }
      }
    }
  }
}

@Composable
private fun DriveFileRow(file: DriveFile, onClick: () -> Unit) {
  Card(
    modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Icon(
        driveFileIcon(file.mimeType),
        contentDescription = null,
        modifier = Modifier.size(24.dp),
        tint = driveFileColor(file.mimeType),
      )
      Spacer(modifier = Modifier.width(12.dp))
      Column(modifier = Modifier.weight(1f)) {
        Text(
          file.name,
          style = MaterialTheme.typography.bodyLarge,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        file.modifiedTime?.let { time ->
          Text(
            time.take(10),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      }
    }
  }
}
