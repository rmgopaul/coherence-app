package com.coherence.healthconnect.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

/** Receiver for the right half of the King widget pair. */
class CoherenceKingRightWidgetReceiver : GlanceAppWidgetReceiver() {

  override val glanceAppWidget: GlanceAppWidget = CoherenceKingRightWidget()

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
    const val ACTION_REFRESH = "com.coherence.healthconnect.widget.king.right.ACTION_REFRESH"
  }
}
