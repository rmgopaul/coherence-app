package com.coherence.healthconnect.widget

import android.content.Context
import kotlinx.serialization.json.Json
import java.io.File

/**
 * File-backed store for widget snapshot data.
 *
 * Atomic write: serialize to a sibling `.tmp` file and rename into
 * place. POSIX `rename(2)` on the same filesystem is atomic, so
 * readers either see the previous complete payload or the new
 * complete payload — never a half-truncated file.
 *
 * The original implementation called `openFileOutput(FILE_NAME,
 * MODE_PRIVATE)`, which truncates the target before writing. If the
 * Glance widget's `provideGlance()` ran during that truncate window
 * (e.g. simultaneous BootReceiver-triggered worker + launcher widget
 * bind), `load()` saw an empty/partial JSON, the JSON decoder threw,
 * the catch returned `WidgetData()`, and the widget rendered with
 * just the header + timestamp ("blank widget" symptom). Force-closing
 * the app re-bound the widget and `load()` then returned the
 * already-completed file. Atomic write removes the partial-read
 * window entirely.
 */
object WidgetDataStore {

  private const val FILE_NAME = "coherence_widget_data.json"
  private const val TEMP_SUFFIX = ".tmp"

  private val json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
  }

  fun save(context: Context, data: WidgetData) {
    val raw = json.encodeToString(WidgetData.serializer(), data)
    val finalFile = File(context.filesDir, FILE_NAME)
    val tempFile = File(context.filesDir, FILE_NAME + TEMP_SUFFIX)
    tempFile.writeBytes(raw.toByteArray())
    if (!tempFile.renameTo(finalFile)) {
      // Same-filesystem rename should always succeed. Fallback (best
      // effort) keeps behavior closer to the pre-atomic version
      // rather than leaving the cache stale on the rare failure.
      finalFile.writeBytes(raw.toByteArray())
      tempFile.delete()
    }
  }

  fun load(context: Context): WidgetData {
    return try {
      val raw = context.openFileInput(FILE_NAME).bufferedReader().readText()
      json.decodeFromString(WidgetData.serializer(), raw)
    } catch (_: Exception) {
      WidgetData()
    }
  }
}
