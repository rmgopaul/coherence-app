package com.coherence.healthconnect.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

/**
 * Broadcast receiver that owns the Coherence dashboard home-screen widget.
 * On every update cycle (and first placement) it kicks off a one-time data
 * refresh so the widget always shows fresh content.
 */
class CoherenceDashboardWidgetReceiver : GlanceAppWidgetReceiver() {

  override val glanceAppWidget: GlanceAppWidget = CoherenceDashboardWidget()

  override fun onEnabled(context: Context) {
    super.onEnabled(context)
    // Start periodic background refresh when the first widget is placed
    WidgetDataWorker.enqueuePeriodicRefresh(context)
  }

  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    super.onUpdate(context, appWidgetManager, appWidgetIds)
    // Trigger an immediate data fetch each update cycle
    WidgetDataWorker.enqueueOneTimeRefresh(context)
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    // Handle manual refresh action
    if (intent.action == ACTION_REFRESH) {
      WidgetDataWorker.enqueueOneTimeRefresh(context)
    }
  }

  companion object {
    const val ACTION_REFRESH = "com.coherence.healthconnect.widget.ACTION_REFRESH"
  }
}
