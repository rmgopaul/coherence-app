/**
 * Task 8.2 (2026-04-27) — unified jobs index.
 *
 * Returns a normalized stream of recent + live jobs across all four
 * runners (contract scan, DIN scrape, Schedule B import, CSG Schedule
 * B import) in one query. The CSG Schedule B runner shares a table
 * with regular Schedule B import, so the index surfaces them as one
 * "schedule-b-import" runnerKind — the Schedule B Manager UI inside
 * the dashboard already distinguishes upload-sourced from CSG-sourced
 * via filename prefix.
 *
 * Used by `/solar-rec/jobs` to render a single live + recent table.
 * Polling cadence is 3s while any row is live.
 */
import {
  desc,
  getDb,
  withDbRetry,
} from "./_core";
import {
  contractScanJobs,
  scheduleBImportJobs,
  dinScrapeJobs,
} from "../../drizzle/schema";
import { eq } from "drizzle-orm";

export type JobsIndexRunnerKind =
  | "contract-scan"
  | "din-scrape"
  | "schedule-b-import";

export type JobsIndexStatus =
  | "queued"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

/**
 * Normalized job row shared across all three job tables. The shape
 * is intentionally the lowest-common-denominator — UI computes
 * percent-complete from `total / (successCount + failureCount)`,
 * lights up live indicators when status is in {queued, running,
 * stopping}, and shows `currentItem` while a worker is mid-flight.
 */
export interface JobsIndexRow {
  id: string;
  runnerKind: JobsIndexRunnerKind;
  status: JobsIndexStatus;
  /** "Total contracts" / "total files" / "total sites" depending on
   *  runner. Already stored on the job row by the runner setup code. */
  total: number;
  successCount: number;
  failureCount: number;
  /** currentCsgId or currentFileName — `null` when queued or done. */
  currentItem: string | null;
  error: string | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/**
 * Whether a status string represents an in-flight job. Used both
 * server-side (to gate live indicators) and client-side (to gate
 * the 3-second poll). Keep in sync with the runner state machines.
 */
export function isLiveJobStatus(status: string): boolean {
  return status === "queued" || status === "running" || status === "stopping";
}

/**
 * Comparator for the merged job list. Newest createdAt first, with
 * updatedAt as a tiebreaker so a row that just transitioned beats
 * an older queued-but-unstarted row sharing the same createdAt
 * timestamp. Exposed for testability — the inner merge logic uses
 * this directly.
 */
export function compareJobsIndexRows(
  a: JobsIndexRow,
  b: JobsIndexRow
): number {
  const aCreated = a.createdAt?.getTime() ?? 0;
  const bCreated = b.createdAt?.getTime() ?? 0;
  if (bCreated !== aCreated) return bCreated - aCreated;
  const aUpdated = a.updatedAt?.getTime() ?? 0;
  const bUpdated = b.updatedAt?.getTime() ?? 0;
  return bUpdated - aUpdated;
}

/**
 * Fetch up to `limit` rows from each of the 3 job tables, normalize
 * to JobsIndexRow, merge, and order by `createdAt DESC`. Default
 * limit is 25 per table → up to 75 rows returned, which keeps the
 * payload well under the 1 MB hard rule from CLAUDE.md.
 *
 * Live jobs are included implicitly because they sort to the top by
 * `createdAt`. The caller (UI) treats them specially via
 * `isLiveJobStatus`.
 */
export async function listRecentJobsAcrossRunners(
  scopeId: string,
  limit = 25
): Promise<JobsIndexRow[]> {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list recent jobs across runners", async () => {
    const [contractRows, scheduleBRows, dinRows] = await Promise.all([
      db
        .select({
          id: contractScanJobs.id,
          status: contractScanJobs.status,
          total: contractScanJobs.totalContracts,
          successCount: contractScanJobs.successCount,
          failureCount: contractScanJobs.failureCount,
          currentItem: contractScanJobs.currentCsgId,
          error: contractScanJobs.error,
          startedAt: contractScanJobs.startedAt,
          stoppedAt: contractScanJobs.stoppedAt,
          completedAt: contractScanJobs.completedAt,
          createdAt: contractScanJobs.createdAt,
          updatedAt: contractScanJobs.updatedAt,
        })
        .from(contractScanJobs)
        .where(eq(contractScanJobs.scopeId, scopeId))
        .orderBy(desc(contractScanJobs.createdAt))
        .limit(limit),
      db
        .select({
          id: scheduleBImportJobs.id,
          status: scheduleBImportJobs.status,
          total: scheduleBImportJobs.totalFiles,
          successCount: scheduleBImportJobs.successCount,
          failureCount: scheduleBImportJobs.failureCount,
          currentItem: scheduleBImportJobs.currentFileName,
          error: scheduleBImportJobs.error,
          startedAt: scheduleBImportJobs.startedAt,
          stoppedAt: scheduleBImportJobs.stoppedAt,
          completedAt: scheduleBImportJobs.completedAt,
          createdAt: scheduleBImportJobs.createdAt,
          updatedAt: scheduleBImportJobs.updatedAt,
        })
        .from(scheduleBImportJobs)
        .where(eq(scheduleBImportJobs.scopeId, scopeId))
        .orderBy(desc(scheduleBImportJobs.createdAt))
        .limit(limit),
      db
        .select({
          id: dinScrapeJobs.id,
          status: dinScrapeJobs.status,
          total: dinScrapeJobs.totalSites,
          successCount: dinScrapeJobs.successCount,
          failureCount: dinScrapeJobs.failureCount,
          currentItem: dinScrapeJobs.currentCsgId,
          error: dinScrapeJobs.error,
          startedAt: dinScrapeJobs.startedAt,
          stoppedAt: dinScrapeJobs.stoppedAt,
          completedAt: dinScrapeJobs.completedAt,
          createdAt: dinScrapeJobs.createdAt,
          updatedAt: dinScrapeJobs.updatedAt,
        })
        .from(dinScrapeJobs)
        .where(eq(dinScrapeJobs.scopeId, scopeId))
        .orderBy(desc(dinScrapeJobs.createdAt))
        .limit(limit),
    ]);

    const merged: JobsIndexRow[] = [
      ...contractRows.map(
        (r): JobsIndexRow => ({
          ...r,
          runnerKind: "contract-scan",
          // scheduleBImportJobs.status is varchar; the others are
          // mysqlEnum. Cast through the shared union — the runner
          // state machines never write outside it.
          status: r.status as JobsIndexStatus,
        })
      ),
      ...scheduleBRows.map(
        (r): JobsIndexRow => ({
          ...r,
          runnerKind: "schedule-b-import",
          status: r.status as JobsIndexStatus,
        })
      ),
      ...dinRows.map(
        (r): JobsIndexRow => ({
          ...r,
          runnerKind: "din-scrape",
          status: r.status as JobsIndexStatus,
        })
      ),
    ];

    // Live jobs sort to the top because their `createdAt` is recent.
    // For two rows with the same createdAt, fall back to updatedAt
    // so a job that just transitioned beats an older queued job.
    merged.sort(compareJobsIndexRows);

    return merged;
  });
}
