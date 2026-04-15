package com.coherence.samsunghealth.sdk

import android.content.Context
import java.time.Instant

/**
 * Persistent rate-limit cooldown for Health Connect reads.
 *
 * When [HealthConnectReader] exhausts its retry budget on a rate-limit
 * error, we don't just give up that single read — we mark the entire
 * Health Connect surface as "cooled down" for several hours. While
 * the cooldown is active, every periodic sync, every backfill, and
 * every manual read short-circuits without making *any* HTTP calls
 * to Health Connect.
 *
 * This is necessary because Health Connect's per-app quota is on a
 * rolling 24h window, and the moment we start being rate limited
 * every additional call digs the hole deeper. The previous design
 * had every 15-minute periodic worker firing 22 fresh reads at a
 * quota that was already exhausted, which prevented the quota from
 * ever recovering. The cooldown gives the quota space to refill.
 *
 * State is stored in SharedPreferences so it survives process death,
 * app restarts, and device reboots. The value is cleared on the next
 * successful read.
 */
class HealthConnectCooldown(
  private val context: Context,
  private val clock: () -> Instant = Instant::now,
) {

  data class State(
    val active: Boolean,
    val until: Instant?,
    val lastMessage: String?,
  )

  /** Snapshot the current cooldown state. */
  fun getState(): State {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val untilMs = prefs.getLong(KEY_COOLDOWN_UNTIL_MS, 0L)
    if (untilMs <= 0L) {
      return State(active = false, until = null, lastMessage = null)
    }
    val until = Instant.ofEpochMilli(untilMs)
    val now = clock()
    val active = until.isAfter(now)
    val message = prefs.getString(KEY_LAST_MESSAGE, null)
    return State(active = active, until = until, lastMessage = message)
  }

  fun isInCooldown(): Boolean = getState().active

  /**
   * Record a rate-limit hit. Bumps the cooldown deadline forward
   * by [hours] from now and stores the underlying error message
   * so the UI can surface it.
   *
   * Re-entrant: calling this while already cooled down extends the
   * deadline rather than ignoring the new hit, on the theory that
   * "we're still being throttled" is fresh evidence the quota
   * hasn't recovered yet.
   */
  fun markRateLimited(message: String, hours: Long = DEFAULT_COOLDOWN_HOURS) {
    val until = clock().plusSeconds(hours * SECONDS_PER_HOUR).toEpochMilli()
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putLong(KEY_COOLDOWN_UNTIL_MS, until)
      .putString(KEY_LAST_MESSAGE, message.take(MESSAGE_TRUNCATION_CHARS))
      .apply()
  }

  /**
   * Clear the cooldown. Called by the reader on any successful read,
   * since a successful read is conclusive evidence that the quota has
   * replenished enough to make progress.
   */
  fun clear() {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .remove(KEY_COOLDOWN_UNTIL_MS)
      .remove(KEY_LAST_MESSAGE)
      .apply()
  }

  companion object {
    /**
     * Re-uses the same SharedPreferences file as
     * `AutoSyncScheduler` so all sync-related state lives in one
     * place (one file to wipe to fully reset the integration).
     */
    private const val PREFS_NAME = "coherence_samsung_sync_prefs"
    private const val KEY_COOLDOWN_UNTIL_MS = "rate_limit_cooldown_until_ms"
    private const val KEY_LAST_MESSAGE = "rate_limit_last_message"
    private const val DEFAULT_COOLDOWN_HOURS = 4L
    private const val SECONDS_PER_HOUR = 3600L
    private const val MESSAGE_TRUNCATION_CHARS = 500
  }
}
