package com.coherence.healthconnect.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

/**
 * Glance receiver for `CoherenceKingWidget` — the Z Fold 7-sized
 * variant of the dashboard widget. Mirrors `CoherenceDashboardWidgetReceiver`
 * exactly: same periodic-refresh schedule, same one-shot refresh on
 * each `onUpdate`, same `ACTION_REFRESH` broadcast handling.
 *
 * Both receivers share `WidgetDataWorker` (the worker is keyed by
 * unique-work name, so enqueuing twice is a no-op). The worker's
 * save() ends with `updateAll()` calls for both widget classes so a
 * single tick repaints both home-screen surfaces.
 */
class CoherenceKingWidgetReceiver : GlanceAppWidgetReceiver() {

  override val glanceAppWidget: GlanceAppWidget = CoherenceKingWidget()

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
    const val ACTION_REFRESH = "com.coherence.healthconnect.widget.king.ACTION_REFRESH"
  }
}
