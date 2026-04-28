/**
 * Job runner that fetches Schedule B PDFs from the CSG portal for a
 * list of CSG IDs and feeds them through the Schedule B extraction
 * pipeline. Results are written to scheduleBImportResults so the
 * existing "Apply as Delivery Schedule" flow processes them.
 *
 * Modeled on contractScanJobRunner.ts with the same concurrency,
 * session refresh, and error handling patterns.
 */

import { runJobWithAtomicCounters } from "./jobRunner";

const CSG_SCHEDULE_B_CONCURRENCY = 3;
const CSG_SCHEDULE_B_SESSION_REFRESH_INTERVAL = 80;
const LOG_PREFIX = "[csgScheduleBImport]";

/** Task 8.1: ship a version marker so deploys are observable. */
export const CSG_SCHEDULE_B_IMPORT_RUNNER_VERSION =
  "csg-schedule-b-import-runner@1";

const activeRunners = new Set<string>();

export function isCsgScheduleBImportRunnerActive(jobId: string): boolean {
  return activeRunners.has(jobId);
}

function parseJsonMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export async function runCsgScheduleBImportJob(jobId: string): Promise<void> {
  const id = jobId.trim();
  if (!id || activeRunners.has(id)) return;

  const {
    getScheduleBImportJob,
    updateScheduleBImportJob,
    incrementScheduleBImportJobCounter,
    upsertScheduleBImportResult,
    getScheduleBImportCsgIdsForJob,
    getSuccessfulScheduleBImportFileNames,
    getIntegrationByProvider,
  } = await import("../../db");

  const job = await getScheduleBImportJob(id);
  if (!job) return;

  activeRunners.add(id);

  try {
    // ── Resolve CSG portal credentials ──────────────────────────
    const CSG_PORTAL_PROVIDER = "csg-portal";
    const integration = await getIntegrationByProvider(job.userId, CSG_PORTAL_PROVIDER);
    const metadata = parseJsonMetadata(integration?.metadata);
    const email = typeof metadata.email === "string" && metadata.email ? metadata.email : null;
    const password = integration?.accessToken || null;
    const baseUrl = typeof metadata.baseUrl === "string" && metadata.baseUrl ? metadata.baseUrl : undefined;

    if (!email || !password) {
      await updateScheduleBImportJob(id, {
        status: "failed",
        error: "Missing CSG portal credentials. Save portal email/password in Settings and retry.",
        completedAt: new Date(),
      });
      return;
    }

    // ── Mark running ────────────────────────────────────────────
    await updateScheduleBImportJob(id, {
      status: "running",
      error: null,
    });

    // ── Login to portal ─────────────────────────────────────────
    const { extractScheduleBDataFromPdfBuffer } = await import("./scheduleBScannerServer");
    const { CsgPortalClient } = await import("../integrations/csgPortal");
    const client = new CsgPortalClient({ email, password, baseUrl });
    await client.login();

    // ── Determine pending CSG IDs ───────────────────────────────
    const allCsgIds = await getScheduleBImportCsgIdsForJob(id);
    const successfulNames = await getSuccessfulScheduleBImportFileNames(id);

    // CSG-sourced filenames use the pattern "csg-portal/schedule-b-{csgId}.pdf"
    const makeCsgFileName = (csgId: string) => `csg-portal/schedule-b-${csgId}.pdf`;
    const pendingCsgIds = allCsgIds.filter(
      (row) => !successfulNames.has(makeCsgFileName(row.csgId))
    );

    if (pendingCsgIds.length === 0) {
      await updateScheduleBImportJob(id, {
        status: "completed",
        completedAt: new Date(),
        currentFileName: null,
      });
      console.log(`${LOG_PREFIX} job=${id.slice(0, 8)} — no pending CSG IDs`);
      return;
    }

    console.log(
      `${LOG_PREFIX} job=${id.slice(0, 8)} — ${pendingCsgIds.length} pending of ${allCsgIds.length} total CSG IDs ` +
        `(${successfulNames.size} already successful)`
    );

    // ── Session refresh mutex ───────────────────────────────────
    let completedSinceLastRefresh = 0;
    let sessionRefreshInFlight: Promise<void> | null = null;
    let cancellationLatch = false;

    const refreshSessionIfNeeded = async (): Promise<void> => {
      if (completedSinceLastRefresh < CSG_SCHEDULE_B_SESSION_REFRESH_INTERVAL) return;
      if (!sessionRefreshInFlight) {
        sessionRefreshInFlight = (async () => {
          try {
            await client.login();
          } finally {
            completedSinceLastRefresh = 0;
            sessionRefreshInFlight = null;
          }
        })();
      }
      await sessionRefreshInFlight;
    };

    /**
     * Cancellation poll. Runs before every item via the shared
     * `runJobWithAtomicCounters` helper. The original runner polled
     * the job row once per item — kept that cadence here (no
     * throttle) since portal-fetch latency dominates the cost.
     */
    const isCancelled = async (): Promise<boolean> => {
      if (cancellationLatch) return true;
      const currentJob = await getScheduleBImportJob(id).catch(() => null);
      if (currentJob?.status === "stopping") cancellationLatch = true;
      return cancellationLatch;
    };

    // ── Process each CSG ID via the shared runner ───────────────
    await runJobWithAtomicCounters<{ csgId: string }>({
      jobId: id,
      pendingItems: pendingCsgIds,
      concurrency: CSG_SCHEDULE_B_CONCURRENCY,
      isCancelled,
      incrementCounter: (field) =>
        incrementScheduleBImportJobCounter(id, field),
      processItem: async (row) => {
        const csgId = row.csgId;
        const fileName = makeCsgFileName(csgId);

        await updateScheduleBImportJob(id, { currentFileName: `CSG:${csgId}` });
        await refreshSessionIfNeeded();

        let rowError: string | null = null;
        let extraction: Awaited<
          ReturnType<typeof extractScheduleBDataFromPdfBuffer>
        > | null = null;

        try {
          let fetchResult = await client.fetchScheduleBFile(csgId);

          // Retry on session errors
          if (
            fetchResult.error &&
            /session|login|timed out|authenticate/i.test(fetchResult.error)
          ) {
            try {
              await client.login();
              fetchResult = await client.fetchScheduleBFile(csgId);
            } catch {
              // Use original error
            }
          }

          if (fetchResult.error) {
            rowError = fetchResult.error;
          } else if (!fetchResult.pdfData) {
            rowError = "No PDF data returned from portal.";
          } else {
            extraction = await Promise.race([
              extractScheduleBDataFromPdfBuffer(
                fetchResult.pdfData,
                fetchResult.pdfFileName || fileName
              ),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () =>
                    reject(new Error("Schedule B extraction timed out (120s)")),
                  120_000
                )
              ),
            ]);
            if (extraction.error) rowError = extraction.error;
          }
        } catch (err) {
          rowError =
            err instanceof Error
              ? err.message
              : "Unknown CSG Schedule B runner error.";
        }

        // ── ALWAYS write a result row ─────────────────────────
        try {
          await upsertScheduleBImportResult({
            jobId: id,
            fileName,
            designatedSystemId: extraction?.designatedSystemId ?? null,
            gatsId: extraction?.gatsId ?? null,
            acSizeKw: extraction?.acSizeKw ?? null,
            capacityFactor: extraction?.capacityFactor ?? null,
            contractPrice: extraction?.contractPrice ?? null,
            contractNumber: extraction?.contractNumber ?? null,
            energizationDate: extraction?.energizationDate ?? null,
            maxRecQuantity: extraction?.maxRecQuantity ?? null,
            deliveryYearsJson: JSON.stringify(extraction?.deliveryYears ?? []),
            error: rowError,
            scannedAt: new Date(),
          });
        } catch (dbErr) {
          // DB-write failure is logged as a hard error; the helper
          // will treat this as a failure outcome below.
          console.error(
            `${LOG_PREFIX} upsertScheduleBImportResult FAILED for job=${id.slice(0, 8)} csg=${csgId}:`,
            dbErr instanceof Error ? dbErr.message : dbErr
          );
          return { outcome: "failure" as const };
        }

        completedSinceLastRefresh += 1;

        // Counter increment is handled by the outer helper using
        // this return value. Same logic as before:
        // success ↔ extraction has at least one delivery year.
        if (
          !rowError &&
          extraction &&
          extraction.deliveryYears.length > 0
        ) {
          return { outcome: "success" as const };
        }
        return { outcome: "failure" as const };
      },
    });

    // ── Final status ────────────────────────────────────────────
    const finalJob = await getScheduleBImportJob(id).catch(() => null);
    if (finalJob?.status === "stopping") {
      await updateScheduleBImportJob(id, {
        status: "completed",
        stoppedAt: new Date(),
        currentFileName: null,
      });
    } else {
      await updateScheduleBImportJob(id, {
        status: "completed",
        completedAt: new Date(),
        currentFileName: null,
      });
    }
    console.log(`${LOG_PREFIX} job=${id.slice(0, 8)} — completed`);
  } catch (err) {
    console.error(`${LOG_PREFIX} job=${id.slice(0, 8)} — fatal error:`, err);
    try {
      await updateScheduleBImportJob(id, {
        status: "failed",
        error: err instanceof Error ? err.message : "Unknown fatal error",
        completedAt: new Date(),
      });
    } catch {
      // Best effort
    }
  } finally {
    activeRunners.delete(id);
  }
}
