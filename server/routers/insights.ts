/**
 * Cross-domain insights router — Anthropic correlation summaries
 * over the trailing 90 days of biological + behavioral data.
 *
 * Two procedures:
 *   - `getLatest` — returns the most recent stored insight set.
 *     Cheap; called on dashboard render.
 *   - `generate` — runs the Anthropic call and upserts a row keyed
 *     on (userId, today). Idempotent within a day so the user can
 *     hit "Refresh" without spamming the API.
 *
 * The full generator service lives at
 * `server/services/notifications/insights.ts` so it can be shared
 * with a future cron without depending on tRPC context.
 */
import { router, protectedProcedure } from "../_core/trpc";
import { formatTodayKey } from "@shared/dateKey";

export const insightsRouter = router({
  /**
   * Return the latest stored insight set + its metadata. Returns
   * `{ insight: null }` when the user has never generated one.
   */
  getLatest: protectedProcedure.query(async ({ ctx }) => {
    const { getLatestUserInsight } = await import("../db");
    const row = await getLatestUserInsight(ctx.user.id);
    if (!row) {
      return {
        _runnerVersion: "insights-v1",
        insight: null as null,
      };
    }
    let parsed: unknown[] = [];
    try {
      const raw = JSON.parse(row.insightsJson);
      if (Array.isArray(raw)) parsed = raw;
    } catch {
      // Treat malformed JSON as no insights — the row is still
      // returned so the UI can show the timestamp + status.
    }
    return {
      _runnerVersion: "insights-v1",
      insight: {
        id: row.id,
        dateKey: row.dateKey,
        rangeStartKey: row.rangeStartKey,
        rangeEndKey: row.rangeEndKey,
        generatedAt: row.generatedAt.toISOString(),
        model: row.model,
        daysAnalyzed: row.daysAnalyzed,
        promptVersion: row.promptVersion,
        status: row.status,
        errorMessage: row.errorMessage,
        items: parsed,
      },
    };
  }),

  /**
   * Force a regenerate. Returns the same shape as `getLatest` so the
   * client can update its query cache from the mutation result.
   */
  generate: protectedProcedure.mutation(async ({ ctx }) => {
    const { generateInsightsForUser } = await import(
      "../services/notifications/insights"
    );
    const today = formatTodayKey();
    const result = await generateInsightsForUser(ctx.user.id, today);
    return {
      _runnerVersion: "insights-v1",
      ...result,
    };
  }),
});
