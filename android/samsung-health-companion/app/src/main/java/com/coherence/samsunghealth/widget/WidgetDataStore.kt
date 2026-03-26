package com.coherence.samsunghealth.widget

import android.content.Context
import kotlinx.serialization.json.Json

/**
 * Simple file-backed store for widget snapshot data.
 * Uses internal storage so no extra permissions are needed.
 */
object WidgetDataStore {

  private const val FILE_NAME = "coherence_widget_data.json"

  private val json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
  }

  fun save(context: Context, data: WidgetData) {
    val raw = json.encodeToString(WidgetData.serializer(), data)
    context.openFileOutput(FILE_NAME, Context.MODE_PRIVATE).use { it.write(raw.toByteArray()) }
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
