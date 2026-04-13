/**
 * Job runner that fetches Schedule B PDFs from the CSG portal for a
 * list of CSG IDs and feeds them through the Schedule B extraction
 * pipeline. Results are written to scheduleBImportResults so the
 * existing "Apply as Delivery Schedule" flow processes them.
 *
 * Modeled on contractScanJobRunner.ts with the same concurrency,
 * session refresh, and error handling patterns.
 */

const CSG_SCHEDULE_B_CONCURRENCY = 3;
const CSG_SCHEDULE_B_SESSION_REFRESH_INTERVAL = 80;
const LOG_PREFIX = "[csgScheduleBImport]";

const activeRunners = new Set<string>();

export function isCsgScheduleBImportRunnerActive(jobId: string): boolean {
  return activeRunners.has(jobId);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await mapper(items[i], i);
    }
  };
  const count = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
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
  if (job.status === "completed" || job.status === "failed") return;

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
    let cancelled = false;

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

    // ── Process each CSG ID ─────────────────────────────────────
    await mapWithConcurrency(
      pendingCsgIds,
      CSG_SCHEDULE_B_CONCURRENCY,
      async (row) => {
        if (cancelled) return;

        // Check for cancellation
        const currentJob = await getScheduleBImportJob(id).catch(() => null);
        if (currentJob?.status === "stopping") {
          cancelled = true;
          return;
        }

        const csgId = row.csgId;
        const fileName = makeCsgFileName(csgId);

        await updateScheduleBImportJob(id, { currentFileName: `CSG:${csgId}` });
        await refreshSessionIfNeeded();

        let rowError: string | null = null;
        let extraction: Awaited<ReturnType<typeof extractScheduleBDataFromPdfBuffer>> | null = null;

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
              extractScheduleBDataFromPdfBuffer(fetchResult.pdfData, fetchResult.pdfFileName || fileName),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Schedule B extraction timed out (120s)")), 120_000)
              ),
            ]);
            if (extraction.error) {
              rowError = extraction.error;
            }
          }
        } catch (err) {
          rowError = err instanceof Error ? err.message : "Unknown CSG Schedule B runner error.";
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
          console.error(
            `${LOG_PREFIX} upsertScheduleBImportResult FAILED for job=${id.slice(0, 8)} csg=${csgId}:`,
            dbErr instanceof Error ? dbErr.message : dbErr
          );
          return;
        }

        // ── Increment counter ─────────────────────────────────
        try {
          if (!rowError && extraction && extraction.deliveryYears.length > 0) {
            await incrementScheduleBImportJobCounter(id, "successCount");
          } else {
            await incrementScheduleBImportJobCounter(id, "failureCount");
          }
        } catch {
          // Non-fatal — counter might be slightly off
        }

        completedSinceLastRefresh += 1;
      }
    );

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
