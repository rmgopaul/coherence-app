package com.coherence.healthconnect.ui.navigation

/**
 * All navigation route constants. Prevents string duplication across
 * AppNavGraph and BottomNavBar.
 */
object Routes {
  // Bottom nav tabs
  const val DASHBOARD = "dashboard"
  const val TASKS = "tasks"
  const val CALENDAR = "calendar"
  const val HEALTH = "health"
  const val MORE = "more"

  // Detail / push routes
  const val CHAT = "chat"
  const val NOTES = "notes"
  const val SUPPLEMENTS = "supplements"
  const val HABITS = "habits"
  const val DAILY_LOG = "dailylog"
  const val DRIVE = "drive"
  const val CLOCKIFY = "clockify"
  const val SETTINGS = "settings"
}
