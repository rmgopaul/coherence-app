package com.coherence.healthconnect.data.model

enum class ThemeMode {
  SYSTEM,
  LIGHT,
  DARK,
}

data class AppPreferences(
  val themeMode: ThemeMode = ThemeMode.SYSTEM,
  val dynamicColorEnabled: Boolean = true,
  val trueBlackEnabled: Boolean = false,
  val refreshIntervalMinutes: Int = 15,
  val focusDurationMinutes: Int = 25,
  val lockTimeoutMinutes: Int = 5,
  val hiddenWidgets: Set<String> = emptySet(),
  // Phase G — when true, the dashboard collapses to King + FocusRail
  // and non-essential refresh jobs are paused. Per-device (DataStore),
  // not synced server-side.
  val focusMode: Boolean = false,
)
