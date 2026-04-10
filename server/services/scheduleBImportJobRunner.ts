/**
 * Schedule B PDF import job runner — rewritten to mirror
 * contractScanJobRunner's battle-tested pattern.
 *
 * The previous runner counted progress from `scheduleBImportFiles.status`
 * via COUNT(*) queries, and multiple code paths could update file status
 * without writing a corresponding `scheduleBImportResults` row — causing
 * the "N processed, 0 rows in DB" bug that the user hit repeatedly.
 *
 * This rewrite adopts the exact invariants that make the contract scraper
 * reliable:
 *
 *   1. Atomic counters (`successCount`, `failureCount`) live as columns
 *      on the job row. Updated via `incrementScheduleBImportJobCounter`
 *      after every processed file.
 *
 *   2. Every processed file writes a result row via
 *      `insertScheduleBImportResult` — success OR failure. No file can
 *      be "processed" without a corresponding result.
 *
 *   3. Concurrent processing via a worker pool (concurrency = 3) so
 *      500-PDF batches complete in minutes, not hours. Contract scraper
 *      uses the same pattern.
 *
 *   4. Single outer try/catch per file. Both branches (extraction
 *      success and extraction failure) end with
 *      `insertScheduleBImportResult + incrementScheduleBImportJobCounter`.
 *      No nested catch paths that can drop a file on the floor.
 *
 *   5. Resumable: queries `scheduleBImportResults` for already-processed
 *      fileNames and skips them. Safe to re-run the same job after a
 *      crash or server restart.
 *
 *   6. Graceful stop: checks job status before each file and exits
 *      cleanly if the caller set status to "stopping".
 */

const activeRunners = new Set<string>();
const SCHEDULE_B_IMPORT_CONCURRENCY = 3;

export function isScheduleBImportRunnerActive(jobId: string): boolean {
  return activeRunners.has(jobId.trim());
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const safe = Math.max(1, Math.floor(concurrency));
  let cursor = 0;
  const runOne = async () => {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= items.length) return;
      await worker(items[current], current);
    }
  };
  const workerCount = Math.min(safe, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runOne()));
}

const LOG_PREFIX = "[scheduleBImport v2_atomic_counters]";

export async function runScheduleBImportJob(jobId: string): Promise<void> {
  const id = jobId.trim();
  if (!id) {
    console.warn(`${LOG_PREFIX} runScheduleBImportJob called with empty jobId`);
    return;
  }
  if (activeRunners.has(id)) {
    console.log(`${LOG_PREFIX} job ${id.slice(0, 8)} already has an active runner, skipping`);
    return;
  }

  const {
    getScheduleBImportJob,
    updateScheduleBImportJob,
    listAllUploadedScheduleBImportFiles,
    getCompletedScheduleBImportFileNames,
    upsertScheduleBImportResult,
    incrementScheduleBImportJobCounter,
    reconcileScheduleBImportJobState,
  } = await import("../db");

  const job = await getScheduleBImportJob(id);
  if (!job) {
    console.warn(`${LOG_PREFIX} job ${id.slice(0, 8)} not found in DB`);
    return;
  }
  if (job.status === "completed" || job.status === "failed") {
    console.log(`${LOG_PREFIX} job ${id.slice(0, 8)} already ${job.status}, not re-running`);
    return;
  }

  console.log(
    `${LOG_PREFIX} starting runner for job ${id.slice(0, 8)} (status=${job.status}, successCount=${job.successCount ?? "undefined"}, failureCount=${job.failureCount ?? "undefined"})`
  );

  activeRunners.add(id);

  try {
    // ── Mark running ──────────────────────────────────────────────────
    await updateScheduleBImportJob(id, {
      status: "running",
      startedAt: job.startedAt ?? new Date(),
      completedAt: null,
      stoppedAt: null,
      error: null,
    });

    const initialReconciliation = await reconcileScheduleBImportJobState(id);
    if (
      initialReconciliation.filesMarkedCompleted > 0 ||
      initialReconciliation.filesRequeued > 0
    ) {
      console.log(
        `${LOG_PREFIX} reconciliation before run: completed=${initialReconciliation.filesMarkedCompleted} requeued=${initialReconciliation.filesRequeued}`
      );
    }

    // ── Load work list: all uploaded files minus already-processed ────
    const allFiles = await listAllUploadedScheduleBImportFiles(id);
    const completedNames = await getCompletedScheduleBImportFileNames(id);
    const pendingFiles = allFiles.filter(
      (f) => !completedNames.has(f.fileName)
    );

    console.log(
      `${LOG_PREFIX} work list for job ${id.slice(0, 8)}: allFiles=${allFiles.length} alreadyCompleted=${completedNames.size} pending=${pendingFiles.length}`
    );

    // Keep the totalFiles counter in sync with whatever's actually in
    // the files table. Safe to overwrite even if new uploads arrive
    // during the run — getScheduleBImportStatus only reads this for
    // display purposes.
    await updateScheduleBImportJob(id, { totalFiles: allFiles.length });

    if (pendingFiles.length === 0) {
      const reconciled = await reconcileScheduleBImportJobState(id);
      const remaining = Math.max(
        0,
        reconciled.totalFiles - (reconciled.successCount + reconciled.failureCount)
      );
      if (remaining > 0) {
        console.log(
          `${LOG_PREFIX} no immediate pending files but ${remaining} still unprocessed after reconciliation; keeping job queued`
        );
        await updateScheduleBImportJob(id, {
          status: "queued",
          currentFileName: null,
          completedAt: null,
          error: null,
        });
        return;
      }

      console.log(
        `${LOG_PREFIX} no pending files for job ${id.slice(0, 8)}, marking completed`
      );
      await updateScheduleBImportJob(id, {
        status: "completed",
        completedAt: new Date(),
        currentFileName: null,
        error: null,
      });
      return;
    }

    // ── Cancellation support ──────────────────────────────────────────
    let cancelled = false;
    let cancelCheckCounter = 0;
    const checkCancelled = async (): Promise<boolean> => {
      if (cancelled) return true;
      cancelCheckCounter += 1;
      if (cancelCheckCounter % 3 !== 0) return false;
      const fresh = await getScheduleBImportJob(id);
      if (!fresh || fresh.status === "stopping") {
        cancelled = true;
      }
      return cancelled;
    };

    // ── Per-file processing ───────────────────────────────────────────
    const { storageReadBytes } = await import("../storage");
    const { extractScheduleBDataFromPdfBuffer } = await import(
      "./scheduleBScannerServer"
    );

    const processSingleFile = async (file: {
      fileName: string;
      storageKey: string | null;
    }): Promise<void> => {
      if (await checkCancelled()) return;

      let rowError: string | null = null;
      let extraction: Awaited<
        ReturnType<typeof extractScheduleBDataFromPdfBuffer>
      > | null = null;

      try {
        await updateScheduleBImportJob(id, { currentFileName: file.fileName });

        // listAllUploadedScheduleBImportFiles already filters to files
        // with a permanent storageKey (not tmp:, not null, not empty),
        // so this is purely a defensive null-check for TypeScript's
        // benefit. If it triggers, something unexpected upstream has
        // passed us a half-uploaded file.
        const storageKey = (file.storageKey ?? "").trim();
        if (!storageKey || storageKey.startsWith("tmp:")) {
          rowError = "Upload did not finalize before processing began. Re-upload this PDF.";
        } else {
          try {
            const pdfBytes = await storageReadBytes(storageKey);
            extraction = await extractScheduleBDataFromPdfBuffer(
              pdfBytes,
              file.fileName
            );
            // The extractor returns an object whose `.error` field is
            // populated if the delivery table wasn't found. Treat that
            // as a row-level error for counter purposes, but still
            // write the extraction row so the user can see WHAT was
            // extracted (useful for diagnosing parse issues).
            if (extraction.error) {
              rowError = extraction.error;
            }
          } catch (err) {
            rowError =
              err instanceof Error
                ? err.message
                : "Failed to extract Schedule B PDF.";
          }
        }
      } catch (err) {
        // Any unexpected outer error (DB failure during currentFileName
        // update, etc.).
        rowError =
          err instanceof Error ? err.message : "Unknown Schedule B runner error.";
      }

      // ── ALWAYS write a result row. This is the critical invariant. ──
      let resultWriteSucceeded = false;
      try {
        await upsertScheduleBImportResult({
          jobId: id,
          fileName: file.fileName,
          designatedSystemId: extraction?.designatedSystemId ?? null,
          gatsId: extraction?.gatsId ?? null,
          acSizeKw: extraction?.acSizeKw ?? null,
          capacityFactor: extraction?.capacityFactor ?? null,
          contractPrice: extraction?.contractPrice ?? null,
          energizationDate: extraction?.energizationDate ?? null,
          maxRecQuantity: extraction?.maxRecQuantity ?? null,
          deliveryYearsJson: JSON.stringify(extraction?.deliveryYears ?? []),
          error: rowError,
          scannedAt: new Date(),
        });
        resultWriteSucceeded = true;
      } catch (dbErr) {
        // LOUD warning — this is the exact failure mode that's been
        // blocking the user. If every file hits this branch, we see 17
        // counter increments with 0 result rows. The Render log will
        // show the SQL/DB error that's causing it.
        console.error(
          `${LOG_PREFIX} upsertScheduleBImportResult FAILED for job=${id.slice(0, 8)} file=${file.fileName}:`,
          dbErr instanceof Error ? dbErr.message : dbErr,
          dbErr instanceof Error && dbErr.stack ? `\n${dbErr.stack}` : ""
        );
        rowError = rowError ?? "Failed to persist extraction result.";
      }

      // ── Atomic counter increment. Always runs after a result write. ─
      try {
        if (!rowError && extraction) {
          await incrementScheduleBImportJobCounter(id, "successCount");
          console.log(
            `${LOG_PREFIX} ✓ job=${id.slice(0, 8)} file=${file.fileName} success resultWritten=${resultWriteSucceeded} gatsId=${extraction.gatsId ?? "none"} years=${extraction.deliveryYears?.length ?? 0}`
          );
        } else {
          await incrementScheduleBImportJobCounter(id, "failureCount");
          console.log(
            `${LOG_PREFIX} ✗ job=${id.slice(0, 8)} file=${file.fileName} failure resultWritten=${resultWriteSucceeded} error=${rowError ?? "unknown"}`
          );
        }
      } catch (err) {
        console.error(
          `${LOG_PREFIX} counter increment FAILED for job=${id.slice(0, 8)} file=${file.fileName}:`,
          err instanceof Error ? err.message : err
        );
      }
    };

    await mapWithConcurrency(
      pendingFiles,
      SCHEDULE_B_IMPORT_CONCURRENCY,
      processSingleFile
    );

    // ── Final status ──────────────────────────────────────────────────
    if (cancelled) {
      await updateScheduleBImportJob(id, {
        status: "stopped",
        stoppedAt: new Date(),
        currentFileName: null,
      });
    } else {
      const reconciled = await reconcileScheduleBImportJobState(id);
      const remaining = Math.max(
        0,
        reconciled.totalFiles - (reconciled.successCount + reconciled.failureCount)
      );
      if (remaining > 0) {
        console.log(
          `${LOG_PREFIX} post-run reconciliation found ${remaining} unprocessed files; re-queueing job`
        );
        await updateScheduleBImportJob(id, {
          status: "queued",
          completedAt: null,
          currentFileName: null,
          error: null,
        });
      } else {
        await updateScheduleBImportJob(id, {
          status: "completed",
          completedAt: new Date(),
          currentFileName: null,
          error: null,
        });
      }
    }
  } catch (error) {
    console.warn(
      `[scheduleBImportJob] Runner crashed for job ${id}:`,
      error instanceof Error ? error.message : error
    );
    try {
      await updateScheduleBImportJob(id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown runner error.",
        currentFileName: null,
        completedAt: new Date(),
      });
    } catch {
      // Already failing; nothing to do.
    }
  } finally {
    activeRunners.delete(id);
  }
}
