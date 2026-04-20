package com.coherence.healthconnect.data.repository

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.coherence.healthconnect.data.model.AppPreferences
import com.coherence.healthconnect.data.model.ThemeMode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private const val DATASTORE_NAME = "coherence_preferences"
private const val HIDDEN_WIDGETS_SEPARATOR = ","

private val Context.appPreferencesDataStore by preferencesDataStore(name = DATASTORE_NAME)

class AppPreferencesRepository(private val context: Context) {
  private object Keys {
    val themeMode = stringPreferencesKey("theme_mode")
    val dynamicColorEnabled = booleanPreferencesKey("dynamic_color_enabled")
    val trueBlackEnabled = booleanPreferencesKey("true_black_enabled")
    val refreshIntervalMinutes = intPreferencesKey("refresh_interval_minutes")
    val focusDurationMinutes = intPreferencesKey("focus_duration_minutes")
    val lockTimeoutMinutes = intPreferencesKey("lock_timeout_minutes")
    val hiddenWidgets = stringPreferencesKey("hidden_widgets")
  }

  val preferences: Flow<AppPreferences> = context.appPreferencesDataStore.data.map { prefs ->
    AppPreferences(
      themeMode = parseThemeMode(prefs[Keys.themeMode]),
      dynamicColorEnabled = prefs[Keys.dynamicColorEnabled] ?: true,
      trueBlackEnabled = prefs[Keys.trueBlackEnabled] ?: false,
      refreshIntervalMinutes = prefs[Keys.refreshIntervalMinutes] ?: 15,
      focusDurationMinutes = prefs[Keys.focusDurationMinutes] ?: 25,
      lockTimeoutMinutes = prefs[Keys.lockTimeoutMinutes] ?: 5,
      hiddenWidgets = parseHiddenWidgets(prefs[Keys.hiddenWidgets]),
    )
  }

  suspend fun setThemeMode(mode: ThemeMode) {
    context.appPreferencesDataStore.edit { prefs ->
      prefs[Keys.themeMode] = mode.name
    }
  }

  suspend fun setDynamicColorEnabled(enabled: Boolean) {
    context.appPreferencesDataStore.edit { prefs ->
      prefs[Keys.dynamicColorEnabled] = enabled
    }
  }

  suspend fun setTrueBlackEnabled(enabled: Boolean) {
    context.appPreferencesDataStore.edit { prefs ->
      prefs[Keys.trueBlackEnabled] = enabled
    }
  }

  suspend fun setRefreshIntervalMinutes(minutes: Int) {
    context.appPreferencesDataStore.edit { prefs ->
      prefs[Keys.refreshIntervalMinutes] = minutes
    }
  }

  suspend fun setFocusDurationMinutes(minutes: Int) {
    context.appPreferencesDataStore.edit { prefs ->
      prefs[Keys.focusDurationMinutes] = minutes
    }
  }

  suspend fun setLockTimeoutMinutes(minutes: Int) {
    context.appPreferencesDataStore.edit { prefs ->
      prefs[Keys.lockTimeoutMinutes] = minutes
    }
  }

  suspend fun setWidgetHidden(widgetId: String, hidden: Boolean) {
    context.appPreferencesDataStore.edit { prefs ->
      val current = parseHiddenWidgets(prefs[Keys.hiddenWidgets]).toMutableSet()
      if (hidden) current.add(widgetId) else current.remove(widgetId)
      prefs[Keys.hiddenWidgets] = current.sorted().joinToString(HIDDEN_WIDGETS_SEPARATOR)
    }
  }

  private fun parseThemeMode(raw: String?): ThemeMode {
    val normalized = raw?.trim().orEmpty()
    return ThemeMode.entries.firstOrNull { it.name.equals(normalized, ignoreCase = true) } ?: ThemeMode.SYSTEM
  }

  private fun parseHiddenWidgets(raw: String?): Set<String> {
    if (raw.isNullOrBlank()) return emptySet()
    return raw
      .split(HIDDEN_WIDGETS_SEPARATOR)
      .map { it.trim() }
      .filter { it.isNotBlank() }
      .toSet()
  }
}
