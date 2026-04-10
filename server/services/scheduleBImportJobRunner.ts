const activeRunners = new Set<string>();

export function isScheduleBImportRunnerActive(jobId: string): boolean {
  return activeRunners.has(jobId.trim());
}

export async function runScheduleBImportJob(jobId: string): Promise<void> {
  const id = jobId.trim();
  if (!id || activeRunners.has(id)) return;

  const {
    getScheduleBImportJob,
    updateScheduleBImportJob,
    listPendingScheduleBImportFiles,
    requeueScheduleBImportProcessingFiles,
    failScheduleBImportFilesWithInvalidStorage,
    upsertScheduleBImportResult,
    getScheduleBImportJobCounts,
    markScheduleBImportFileStatus,
  } = await import("../db");

  const job = await getScheduleBImportJob(id);
  if (!job) return;
  if (job.status === "completed" || job.status === "failed") {
    return;
  }

  activeRunners.add(id);

  try {
    // Recover any files left in "processing" from a prior crash/restart.
    await requeueScheduleBImportProcessingFiles(id);
    // Do not attempt to process stale queue entries that never finalized upload.
    await failScheduleBImportFilesWithInvalidStorage(id);

    await updateScheduleBImportJob(id, {
      status: "running",
      startedAt: job.startedAt ?? new Date(),
      completedAt: null,
      stoppedAt: null,
      error: null,
    });

    const { storageReadBytes } = await import("../storage");
    const { extractScheduleBDataFromPdfBuffer } = await import("./scheduleBScannerServer");

    while (true) {
      const freshJob = await getScheduleBImportJob(id);
      if (!freshJob) return;

      if (freshJob.status === "stopping") {
        await updateScheduleBImportJob(id, {
          status: "stopped",
          stoppedAt: new Date(),
          currentFileName: null,
        });
        return;
      }

      const [nextFile] = await listPendingScheduleBImportFiles(id, 1);
      if (!nextFile) {
        break;
      }

      await markScheduleBImportFileStatus({
        jobId: id,
        fileName: nextFile.fileName,
        status: "processing",
        error: null,
        processedAt: null,
      });
      await updateScheduleBImportJob(id, {
        currentFileName: nextFile.fileName,
      });

      try {
        const storageKey = (nextFile.storageKey ?? "").trim();
        if (!storageKey) {
          throw new Error("Missing uploaded PDF storage key.");
        }

        const pdfBytes = await storageReadBytes(storageKey);
        const extraction = await extractScheduleBDataFromPdfBuffer(pdfBytes, nextFile.fileName);

        await upsertScheduleBImportResult({
          jobId: id,
          fileName: nextFile.fileName,
          designatedSystemId: extraction.designatedSystemId,
          gatsId: extraction.gatsId,
          acSizeKw: extraction.acSizeKw,
          capacityFactor: extraction.capacityFactor,
          contractPrice: extraction.contractPrice,
          energizationDate: extraction.energizationDate,
          maxRecQuantity: extraction.maxRecQuantity,
          deliveryYearsJson: JSON.stringify(extraction.deliveryYears ?? []),
          error: extraction.error ?? null,
          scannedAt: new Date(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Schedule B PDF processing failed.";

        try {
          await upsertScheduleBImportResult({
            jobId: id,
            fileName: nextFile.fileName,
            designatedSystemId: null,
            gatsId: null,
            acSizeKw: null,
            capacityFactor: null,
            contractPrice: null,
            energizationDate: null,
            maxRecQuantity: null,
            deliveryYearsJson: "[]",
            error: message,
            scannedAt: new Date(),
          });
        } catch (resultError) {
          const fallback = resultError instanceof Error ? resultError.message : "Failed to persist extraction error.";
          await markScheduleBImportFileStatus({
            jobId: id,
            fileName: nextFile.fileName,
            status: "failed",
            error: `${message} (${fallback})`,
            processedAt: new Date(),
          });
        }
      } finally {
        await updateScheduleBImportJob(id, {
          currentFileName: null,
        });
      }
    }

    const counts = await getScheduleBImportJobCounts(id);
    if (counts.queuedFiles > 0 || counts.processingFiles > 0) {
      await updateScheduleBImportJob(id, {
        status: "running",
        completedAt: null,
        currentFileName: null,
      });
      return;
    }

    await updateScheduleBImportJob(id, {
      status: "completed",
      completedAt: new Date(),
      currentFileName: null,
      error: null,
    });
  } catch (error) {
    await updateScheduleBImportJob(id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Schedule B background import failed.",
      currentFileName: null,
      completedAt: new Date(),
    });
  } finally {
    activeRunners.delete(id);
  }
}
