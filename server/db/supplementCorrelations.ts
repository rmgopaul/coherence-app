/**
 * DB layer for the `supplementCorrelations` table introduced by
 * Task 6.1 (2026-04-27). Holds pre-computed correlation slices that
 * the nightly snapshot writes; the dashboard reads via
 * `getTopSignalsForUser`.
 */

import { and, desc, eq, getDb, sql, withDbRetry } from "./_core";
import {
  supplementCorrelations,
  type InsertSupplementCorrelation,
  type SupplementCorrelation,
} from "../../drizzle/schema";

/**
 * Idempotent upsert keyed by (userId, supplementId, metric, windowDays,
 * lagDays). The unique index lets `ON DUPLICATE KEY UPDATE` overwrite
 * the row each nightly run without growing the table.
 */
export async function upsertSupplementCorrelation(
  data: InsertSupplementCorrelation
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("upsert supplement correlation", () =>
    db
      .insert(supplementCorrelations)
      .values(data)
      .onDuplicateKeyUpdate({
        set: {
          computedAt: data.computedAt ?? new Date(),
          cohensD: data.cohensD,
          pearsonR: data.pearsonR,
          onN: data.onN,
          offN: data.offN,
          onMean: data.onMean,
          offMean: data.offMean,
          insufficientData: data.insufficientData,
        },
      })
  );
}

/**
 * Top correlation signals for a user, ranked by absolute Cohen's d
 * (effect size). Skips rows with `insufficientData = true` so noise
 * results from small splits never leak to the UI. Default `limit=5`
 * matches the dashboard card's row count.
 *
 * Returned in (`|cohensD|` DESC, `windowDays` DESC) order so a tie
 * prefers the longer window — a 90-day signal is more stable than
 * the matching 30-day version.
 */
export async function getTopSignalsForUser(
  userId: number,
  limit = 5
): Promise<SupplementCorrelation[]> {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("get top supplement signals", () =>
    db
      .select()
      .from(supplementCorrelations)
      .where(
        and(
          eq(supplementCorrelations.userId, userId),
          eq(supplementCorrelations.insufficientData, false)
        )
      )
      .orderBy(
        sql`ABS(${supplementCorrelations.cohensD}) DESC`,
        desc(supplementCorrelations.windowDays)
      )
      .limit(limit)
  );
}

/**
 * Read every cached correlation row for a user. Useful for the
 * Supplements Insights page (shows the full matrix) and for
 * diagnostics.
 */
export async function listCorrelationsForUser(
  userId: number
): Promise<SupplementCorrelation[]> {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list supplement correlations", () =>
    db
      .select()
      .from(supplementCorrelations)
      .where(eq(supplementCorrelations.userId, userId))
  );
}
