package com.coherence.healthconnect.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

/**
 * Receiver for the Coherence habits widget. Shares the same
 * [WidgetDataWorker] pipeline as the dashboard / King widgets so a
 * single periodic refresh repaints every Coherence widget on the
 * home screen.
 */
class CoherenceHabitsWidgetReceiver : GlanceAppWidgetReceiver() {

  override val glanceAppWidget: GlanceAppWidget = CoherenceHabitsWidget()

  override fun onEnabled(context: Context) {
    super.onEnabled(context)
    WidgetDataWorker.enqueuePeriodicRefresh(context)
  }

  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    super.onUpdate(context, appWidgetManager, appWidgetIds)
    WidgetDataWorker.enqueueOneTimeRefresh(context)
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action == ACTION_REFRESH) {
      WidgetDataWorker.enqueueOneTimeRefresh(context)
    }
  }

  companion object {
    const val ACTION_REFRESH = "com.coherence.healthconnect.widget.habits.ACTION_REFRESH"
  }
}
