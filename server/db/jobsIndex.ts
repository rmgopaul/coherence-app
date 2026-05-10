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
 * 2026-05-10 — extended to surface dashboard-rebuild + CSV-export +
 * dataset-upload jobs in the same feed. These three were previously
 * tracked in their own DB tables but had no aggregated UI; rebuilds
 * in particular run for 15-20 minutes and were only observable via
 * the dashboard's header badge. Each new kind normalizes to the same
 * `JobsIndexRow` shape:
 *   - `total` = totalSteps / 1 / totalRows respectively
 *   - `successCount` = currentStep / 1-on-success / rowsWritten
 *   - `failureCount` = 0 / 1-on-failure / rowsParsed-minus-rowsWritten
 *   - `currentItem` = factTable+message / exportType / datasetKey:fileName
 * The conventions trade a small loss of label fidelity (e.g. "1/5"
 * means "step 1 of 5" not "1 contract of 5") for a single rendering
 * path in the UI.
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
  solarRecDashboardBuilds,
  dashboardCsvExportJobs,
  datasetUploadJobs,
} from "../../drizzle/schema";
import { eq } from "drizzle-orm";

export type JobsIndexRunnerKind =
  | "contract-scan"
  | "din-scrape"
  | "schedule-b-import"
  | "dashboard-build"
  | "dashboard-csv-export"
  | "dataset-upload";

export type JobsIndexStatus =
  | "queued"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "succeeded"
  | "failed"
  | "preparing"
  | "uploading"
  | "parsing"
  | "writing"
  | "done";

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
 *
 * Covers all six runner kinds:
 *   - contract / din / schedule-b: queued | running | stopping
 *   - dashboard-build + csv-export: queued | running
 *   - dataset-upload: queued | uploading | parsing | preparing | writing
 */
export function isLiveJobStatus(status: string): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "stopping" ||
    status === "uploading" ||
    status === "parsing" ||
    status === "preparing" ||
    status === "writing"
  );
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
 * Parse a `solarRecDashboardBuilds.progressJson` blob without
 * throwing. The runner writes `{ currentStep, totalSteps, percent,
 * message, factTable }` but the column is unstructured `json` so a
 * future shape drift wouldn't blow up the index read. Returns null
 * for any shape we don't recognise.
 */
function parseBuildProgress(progressJson: unknown): {
  currentStep: number;
  totalSteps: number;
  factTable: string | null;
  message: string | null;
} | null {
  if (!progressJson || typeof progressJson !== "object") return null;
  const obj = progressJson as Record<string, unknown>;
  const currentStep = typeof obj.currentStep === "number" ? obj.currentStep : null;
  const totalSteps = typeof obj.totalSteps === "number" ? obj.totalSteps : null;
  if (currentStep === null || totalSteps === null) return null;
  return {
    currentStep,
    totalSteps,
    factTable:
      typeof obj.factTable === "string"
        ? obj.factTable
        : null,
    message: typeof obj.message === "string" ? obj.message : null,
  };
}

/**
 * Parse a `dashboardCsvExportJobs.input` blob to pull the
 * `exportType` discriminator for the `currentItem` column.
 * Tolerant — unknown shape returns null and the row still renders.
 */
function parseCsvExportType(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  return typeof obj.exportType === "string" ? obj.exportType : null;
}

/**
 * Fetch up to `limit` rows from each job table, normalize to
 * JobsIndexRow, merge, and order by `createdAt DESC`. Default limit
 * is 25 per table → up to 150 rows total (6 tables), well under the
 * 1 MB hard rule from CLAUDE.md.
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
    const [
      contractRows,
      scheduleBRows,
      dinRows,
      buildRows,
      csvExportRows,
      uploadRows,
    ] = await Promise.all([
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
      // Dashboard rebuilds — `progressJson` carries step progress;
      // mapped into total / successCount below. `stoppedAt` not
      // applicable (no cancel state), so it stays null.
      db
        .select({
          id: solarRecDashboardBuilds.id,
          status: solarRecDashboardBuilds.status,
          progressJson: solarRecDashboardBuilds.progressJson,
          errorMessage: solarRecDashboardBuilds.errorMessage,
          startedAt: solarRecDashboardBuilds.startedAt,
          completedAt: solarRecDashboardBuilds.completedAt,
          createdAt: solarRecDashboardBuilds.createdAt,
          updatedAt: solarRecDashboardBuilds.updatedAt,
        })
        .from(solarRecDashboardBuilds)
        .where(eq(solarRecDashboardBuilds.scopeId, scopeId))
        .orderBy(desc(solarRecDashboardBuilds.createdAt))
        .limit(limit),
      // CSV exports — no step progress; success/failure are binary
      // on `status`. `rowCount` populates as the success signal.
      db
        .select({
          id: dashboardCsvExportJobs.id,
          status: dashboardCsvExportJobs.status,
          input: dashboardCsvExportJobs.input,
          rowCount: dashboardCsvExportJobs.rowCount,
          errorMessage: dashboardCsvExportJobs.errorMessage,
          startedAt: dashboardCsvExportJobs.startedAt,
          completedAt: dashboardCsvExportJobs.completedAt,
          createdAt: dashboardCsvExportJobs.createdAt,
          updatedAt: dashboardCsvExportJobs.updatedAt,
        })
        .from(dashboardCsvExportJobs)
        .where(eq(dashboardCsvExportJobs.scopeId, scopeId))
        .orderBy(desc(dashboardCsvExportJobs.createdAt))
        .limit(limit),
      // Dataset uploads — `rowsWritten` / `totalRows` map onto
      // successCount / total directly. `rowsParsed - rowsWritten`
      // approximates failureCount during the active write phase
      // (rows that parsed but were dedup-skipped show up here too,
      // which is fine — the dataset-upload manager UI distinguishes).
      db
        .select({
          id: datasetUploadJobs.id,
          status: datasetUploadJobs.status,
          datasetKey: datasetUploadJobs.datasetKey,
          fileName: datasetUploadJobs.fileName,
          totalRows: datasetUploadJobs.totalRows,
          rowsParsed: datasetUploadJobs.rowsParsed,
          rowsWritten: datasetUploadJobs.rowsWritten,
          errorMessage: datasetUploadJobs.errorMessage,
          startedAt: datasetUploadJobs.startedAt,
          completedAt: datasetUploadJobs.completedAt,
          createdAt: datasetUploadJobs.createdAt,
          updatedAt: datasetUploadJobs.updatedAt,
        })
        .from(datasetUploadJobs)
        .where(eq(datasetUploadJobs.scopeId, scopeId))
        .orderBy(desc(datasetUploadJobs.createdAt))
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
      ...buildRows.map((r): JobsIndexRow => {
        const progress = parseBuildProgress(r.progressJson);
        const totalSteps = progress?.totalSteps ?? 0;
        const currentStep = progress?.currentStep ?? 0;
        const factTable = progress?.factTable;
        const message = progress?.message;
        // `currentItem` surfaces the step name + message so a
        // 15-minute build doesn't look like it's hung at "step 4/5".
        const currentItem =
          factTable && message
            ? `${factTable}: ${message}`
            : factTable ?? message ?? null;
        return {
          id: r.id,
          runnerKind: "dashboard-build",
          status: r.status as JobsIndexStatus,
          total: totalSteps,
          successCount: r.status === "succeeded" ? totalSteps : currentStep,
          failureCount: r.status === "failed" ? 1 : 0,
          currentItem,
          error: r.errorMessage,
          startedAt: r.startedAt,
          stoppedAt: null,
          completedAt: r.completedAt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      }),
      ...csvExportRows.map((r): JobsIndexRow => {
        const exportType = parseCsvExportType(r.input);
        // CSV exports have no incremental progress — they're either
        // queued, running, succeeded, or failed. Use total=1 so the
        // progress label shows "0/1" → "1/1" rather than "—".
        const succeeded = r.status === "succeeded";
        const failed = r.status === "failed";
        return {
          id: r.id,
          runnerKind: "dashboard-csv-export",
          status: r.status as JobsIndexStatus,
          total: 1,
          successCount: succeeded ? 1 : 0,
          failureCount: failed ? 1 : 0,
          currentItem: exportType,
          error: r.errorMessage,
          startedAt: r.startedAt,
          stoppedAt: null,
          completedAt: r.completedAt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      }),
      ...uploadRows.map((r): JobsIndexRow => {
        // Dataset uploads: `rowsWritten` is the canonical success
        // count (rows that landed in the typed columns); the gap
        // between `rowsParsed` and `rowsWritten` represents dedup-
        // skipped rows on append-mode datasets, which we treat as
        // non-failures (they're correctly NOT re-inserted).
        const rowsWritten = r.rowsWritten ?? 0;
        const totalRows = r.totalRows ?? 0;
        return {
          id: r.id,
          runnerKind: "dataset-upload",
          status: r.status as JobsIndexStatus,
          total: totalRows,
          successCount: rowsWritten,
          failureCount: r.status === "failed" ? 1 : 0,
          currentItem: `${r.datasetKey}: ${r.fileName}`,
          error: r.errorMessage,
          startedAt: r.startedAt,
          stoppedAt: null,
          completedAt: r.completedAt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      }),
    ];

    // Live jobs sort to the top because their `createdAt` is recent.
    // For two rows with the same createdAt, fall back to updatedAt
    // so a job that just transitioned beats an older queued job.
    merged.sort(compareJobsIndexRows);

    return merged;
  });
}
