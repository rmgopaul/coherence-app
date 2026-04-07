import { nanoid } from "nanoid";

const CONTRACT_SCAN_SESSION_REFRESH_INTERVAL = 80;
const CONTRACT_SCAN_CONCURRENCY = 3;

/** Set of job IDs with active runners on this process. */
const activeRunners = new Set<string>();

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  const safeConcurrency = Math.max(1, Math.floor(concurrency));
  const results: TOutput[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(
        items[currentIndex],
        currentIndex
      );
    }
  };

  const workerCount = Math.min(safeConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * DB-backed contract scan job runner.
 *
 * Key differences from the legacy in-memory runner:
 * - Writes each result row to the database immediately (no batched snapshots).
 * - Checks for "stopping" status before each contract (graceful stop).
 * - Resumable: queries DB for already-completed IDs and skips them.
 */
export async function runContractScanJob(
  jobId: string
): Promise<void> {
  const id = jobId.trim();
  if (!id || activeRunners.has(id)) return;

  const {
    getContractScanJob,
    updateContractScanJob,
    incrementContractScanJobCounter,
    insertContractScanResult,
    getCompletedCsgIdsForJob,
    getIntegrationByProvider,
  } = await import("../db");

  const job = await getContractScanJob(id);
  if (!job) return;
  if (
    job.status === "completed" ||
    job.status === "failed"
  ) {
    return;
  }

  activeRunners.add(id);

  try {
    // ── Resolve CSG portal credentials ──────────────────────────
    const { toNonEmptyString } = await import("./addressCleaning");
    const CSG_PORTAL_PROVIDER = "csg-portal";

    const integration = await getIntegrationByProvider(
      job.userId,
      CSG_PORTAL_PROVIDER
    );
    const metadata = parseJsonMetadata(integration?.metadata);
    const resolvedEmail = toNonEmptyString(metadata.email);
    const resolvedPassword = toNonEmptyString(
      integration?.accessToken
    );
    const resolvedBaseUrl = toNonEmptyString(metadata.baseUrl);

    if (!resolvedEmail || !resolvedPassword) {
      await updateContractScanJob(id, {
        status: "failed",
        error:
          "Missing CSG portal credentials. Save portal email/password and retry.",
        completedAt: new Date(),
      });
      return;
    }

    // ── Mark running ────────────────────────────────────────────
    await updateContractScanJob(id, {
      status: "running",
      startedAt: job.startedAt ?? new Date(),
      error: null,
      currentCsgId: null,
    });

    // ── Login to portal ─────────────────────────────────────────
    const { extractContractDataFromPdfBuffer } = await import(
      "./contractScannerServer"
    );
    const { CsgPortalClient } = await import("./csgPortal");
    const client = new CsgPortalClient({
      email: resolvedEmail,
      password: resolvedPassword,
      baseUrl: resolvedBaseUrl ?? undefined,
    });
    await client.login();

    // ── Determine pending IDs ───────────────────────────────────
    const completedIds = await getCompletedCsgIdsForJob(id);

    // Load the full CSG ID list from the job's input table
    const { getDb } = await import("../db");
    const { contractScanJobCsgIds } = await import(
      "../../drizzle/schema"
    );
    const { eq, asc } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) {
      await updateContractScanJob(id, {
        status: "failed",
        error: "Database unavailable",
        completedAt: new Date(),
      });
      return;
    }

    const allIdRows = await db
      .select({ csgId: contractScanJobCsgIds.csgId })
      .from(contractScanJobCsgIds)
      .where(eq(contractScanJobCsgIds.jobId, id))
      .orderBy(asc(contractScanJobCsgIds.csgId));

    const allIds = allIdRows.map((r) => r.csgId);
    const pendingIds = allIds.filter(
      (cid) => !completedIds.has(cid)
    );

    if (pendingIds.length === 0) {
      await updateContractScanJob(id, {
        status: "completed",
        completedAt: new Date(),
        currentCsgId: null,
      });
      return;
    }

    // ── Session refresh mutex ───────────────────────────────────
    let completedSinceLastRefresh = 0;
    let sessionRefreshInFlight: Promise<void> | null = null;

    const refreshSessionIfNeeded = async (): Promise<void> => {
      if (
        completedSinceLastRefresh <
        CONTRACT_SCAN_SESSION_REFRESH_INTERVAL
      ) {
        return;
      }
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

    // ── Cancellation flag ───────────────────────────────────────
    let cancelled = false;
    let cancelCheckCounter = 0;

    const checkCancelled = async (): Promise<boolean> => {
      // Only check DB every 3 contracts to limit queries
      cancelCheckCounter += 1;
      if (cancelCheckCounter % 3 !== 0) return cancelled;

      const freshJob = await getContractScanJob(id);
      if (!freshJob || freshJob.status === "stopping") {
        cancelled = true;
      }
      return cancelled;
    };

    // ── Process a single contract ───────────────────────────────
    const processSingleContract = async (
      csgId: string
    ): Promise<void> => {
      if (await checkCancelled()) return;

      await updateContractScanJob(id, { currentCsgId: csgId });
      await refreshSessionIfNeeded();

      let fetched = await client.fetchRecContractPdf(csgId);
      const fetchError = (fetched.error ?? "").toLowerCase();
      const shouldRetryAfterRefresh =
        Boolean(fetchError) &&
        (fetchError.includes("timed out") ||
          fetchError.includes("session is not authenticated") ||
          fetchError.includes("portal login"));

      if (shouldRetryAfterRefresh) {
        try {
          await client.login();
          completedSinceLastRefresh = 0;
        } catch (refreshErr) {
          console.warn(
            `[contractScanJob] Session refresh failed for ${csgId}:`,
            refreshErr instanceof Error
              ? refreshErr.message
              : refreshErr
          );
        }
        fetched = await client.fetchRecContractPdf(csgId);
      }

      let rowError = fetched.error;
      let extraction: Record<string, unknown> | null = null;

      if (
        !rowError &&
        fetched.pdfData &&
        fetched.pdfData.length > 0
      ) {
        try {
          extraction = await extractContractDataFromPdfBuffer(
            fetched.pdfData,
            fetched.pdfFileName ?? `contract-${csgId}.pdf`
          );
        } catch (error) {
          rowError =
            error instanceof Error
              ? error.message
              : "Failed to parse downloaded contract PDF.";
        }
      }

      // Write result row to database immediately
      await insertContractScanResult({
        id: nanoid(),
        jobId: id,
        csgId,
        systemName:
          (extraction?.systemName as string) ?? null,
        vendorFeePercent:
          (extraction?.vendorFeePercent as number) ?? null,
        additionalCollateralPercent:
          (extraction?.additionalCollateralPercent as number) ??
          null,
        ccAuthorizationCompleted:
          (extraction?.ccAuthorizationCompleted as boolean) ??
          null,
        additionalFivePercentSelected:
          (extraction?.additionalFivePercentSelected as boolean) ??
          null,
        ccCardAsteriskCount:
          (extraction?.ccCardAsteriskCount as number) ?? null,
        paymentMethod:
          (extraction?.paymentMethod as string) ?? null,
        payeeName:
          (extraction?.payeeName as string) ?? null,
        mailingAddress1:
          (extraction?.mailingAddress1 as string) ?? null,
        mailingAddress2:
          (extraction?.mailingAddress2 as string) ?? null,
        cityStateZip:
          (extraction?.cityStateZip as string) ?? null,
        recQuantity:
          (extraction?.recQuantity as number) ?? null,
        recPrice: (extraction?.recPrice as number) ?? null,
        acSizeKw: (extraction?.acSizeKw as number) ?? null,
        dcSizeKw: (extraction?.dcSizeKw as number) ?? null,
        pdfUrl: fetched.pdfUrl ?? null,
        pdfFileName: fetched.pdfFileName ?? null,
        error: rowError ?? null,
        scannedAt: new Date(),
      });

      // Atomic counter increment
      if (!rowError && extraction) {
        await incrementContractScanJobCounter(id, "successCount");
      } else {
        await incrementContractScanJobCounter(id, "failureCount");
      }

      completedSinceLastRefresh += 1;
    };

    // ── Run concurrent workers ──────────────────────────────────
    await mapWithConcurrency(
      pendingIds,
      CONTRACT_SCAN_CONCURRENCY,
      async (csgId) => {
        await processSingleContract(csgId);
      }
    );

    // ── Final status ────────────────────────────────────────────
    if (cancelled) {
      await updateContractScanJob(id, {
        status: "stopped",
        stoppedAt: new Date(),
        currentCsgId: null,
      });
    } else {
      await updateContractScanJob(id, {
        status: "completed",
        completedAt: new Date(),
        currentCsgId: null,
      });
    }
  } catch (error) {
    try {
      await updateContractScanJob(id, {
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : "Unknown contract scan job error.",
        completedAt: new Date(),
        currentCsgId: null,
      });
    } catch {
      // Best effort
    }
  } finally {
    activeRunners.delete(id);
  }
}

export function isContractScanRunnerActive(
  jobId: string
): boolean {
  return activeRunners.has(jobId);
}

function parseJsonMetadata(
  raw: string | null | undefined
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? parsed
      : {};
  } catch {
    return {};
  }
}
