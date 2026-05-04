package com.coherence.healthconnect.widget

import android.content.Context
import android.util.Log
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.updateAll
import com.coherence.healthconnect.CoherenceApplication

/**
 * Glance ActionCallback fired when a habit tile in
 * [CoherenceHabitsWidget] is tapped. Toggles the habit's completion
 * for the cached `habitsDateKey`, persists the new state through the
 * tRPC `habits.setCompletion` mutation, and refreshes the widget.
 *
 * Why optimistic-then-network: Glance ActionCallbacks return Unit and
 * the launcher won't wait on a long-running network call before
 * repainting the surface. We flip the cached `WidgetData.habits` row
 * IMMEDIATELY so the launcher sees the new tile color on the next
 * `updateAll`, then hit the network. If the mutation fails we revert
 * the optimistic state and surface a short error string so the next
 * tick will show the prior color again — same shape as the rest of
 * the widget pipeline's error handling.
 */
class ToggleHabitAction : ActionCallback {

  companion object {
    private const val TAG = "ToggleHabitAction"

    val HABIT_ID_KEY: ActionParameters.Key<String> =
      ActionParameters.Key("habitId")
    val CURRENTLY_COMPLETED_KEY: ActionParameters.Key<Boolean> =
      ActionParameters.Key("currentlyCompleted")

    fun parameters(habitId: String, currentlyCompleted: Boolean): ActionParameters =
      actionParametersOf(
        HABIT_ID_KEY to habitId,
        CURRENTLY_COMPLETED_KEY to currentlyCompleted,
      )
  }

  override suspend fun onAction(
    context: Context,
    glanceId: GlanceId,
    parameters: ActionParameters,
  ) {
    val habitId = parameters[HABIT_ID_KEY] ?: return
    val previouslyCompleted = parameters[CURRENTLY_COMPLETED_KEY] ?: false
    val nextCompleted = !previouslyCompleted

    val app = context.applicationContext as CoherenceApplication
    val cached = WidgetDataStore.load(context)
    val dateKey = cached.habitsDateKey

    // Optimistic flip — repaint immediately so the tap feels live.
    val optimistic = cached.copy(
      habits = cached.habits.map { h ->
        if (h.id == habitId) h.copy(completed = nextCompleted) else h
      },
    )
    WidgetDataStore.save(context, optimistic)
    CoherenceHabitsWidget().updateAll(context)

    // Network commit — repository swallows errors and returns false
    // rather than throwing, so we treat that as the failure signal.
    val ok = app.container.habitsRepository.setCompletion(
      habitId = habitId,
      completed = nextCompleted,
      dateKey = dateKey,
    )

    if (!ok) {
      Log.w(TAG, "setCompletion failed for habit=$habitId; reverting")
      val reverted = WidgetDataStore.load(context).copy(
        habits = optimistic.habits.map { h ->
          if (h.id == habitId) h.copy(completed = previouslyCompleted) else h
        },
        error = "Habit didn't sync — tap to retry",
      )
      WidgetDataStore.save(context, reverted)
      CoherenceHabitsWidget().updateAll(context)
    } else {
      // Server accepted. Schedule a background refresh so the streak
      // count on the next paint reflects the new completion (the
      // optimistic flip only updated `completed`, not the streak).
      WidgetDataWorker.enqueueOneTimeRefresh(context)
    }
  }
}
