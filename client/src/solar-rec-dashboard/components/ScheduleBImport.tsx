/**
 * Schedule B PDF import card for the Delivery Tracker tab.
 *
 * Extracted verbatim from client/src/pages/SolarRecDashboard.tsx during
 * Phase 1 session 1 of the dashboard rebuild. Behavior is unchanged.
 *
 * This component owns:
 *  - chunked upload of Schedule B PDFs to the server (via trpc
 *    solarRecDashboard.uploadScheduleBFileChunk)
 *  - polling the background import job for progress
 *  - hydrating previously-uploaded results on mount
 *  - letting the user paste a GATS-ID → Contract-ID mapping that
 *    patches existing delivery schedule rows in place
 *  - converting the scan results into deliveryScheduleBase rows via
 *    the caller-provided onApply callback
 *
 * Self-contained helpers (waitMs, getErrorMessage, ScheduleBResultRow,
 * SCHEDULE_B_* constants) live at the top of this file rather than in
 * a shared module because nothing else in the dashboard uses them.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";

import type { CsvRow } from "../state/types";
import { bytesToBase64 } from "../lib/binaryEncoding";
import { buildCsv, timestampForCsvFileName, triggerCsvDownload } from "../lib/csvIo";

// ── Constants (private to this component) ──────────────────────────
const SCHEDULE_B_UPLOAD_CHUNK_BYTES = 190_000;
const SCHEDULE_B_MAX_SERVER_ROWS = 50_000;
const SCHEDULE_B_UPLOAD_FILE_MAX_ATTEMPTS = 3;
const SCHEDULE_B_UPLOAD_RETRY_BASE_MS = 700;
const SCHEDULE_B_UPLOAD_CHUNK_READ_MAX_ATTEMPTS = 3;
const SCHEDULE_B_UPLOAD_CHUNK_READ_RETRY_BASE_MS = 150;

// ── Helpers (private to this component) ────────────────────────────
const waitMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

type ScheduleBResultRow = {
  extraction: import("@/lib/scheduleBScanner").ScheduleBExtraction;
  adjustedYears: import("@/lib/scheduleBScanner").AdjustedScheduleYear[];
  firstTransferYear: number | null;
};

export type ScheduleBImportProps = {
  transferDeliveryLookup: Map<string, Map<number, number>>;
  onApply: (rows: CsvRow[]) => void;
  existingDeliverySchedule: CsvRow[] | null;
};

export function ScheduleBImport({
  transferDeliveryLookup,
  onApply,
  existingDeliverySchedule,
}: ScheduleBImportProps) {
  const [scheduleBResults, setScheduleBResults] = useState<ScheduleBResultRow[]>([]);
  const [scheduleBUploading, setScheduleBUploading] = useState(false);
  const [scheduleBProgress, setScheduleBProgress] = useState({ current: 0, total: 0 });
  const [scheduleBUploadSummary, setScheduleBUploadSummary] = useState<{
    uploaded: number;
    skipped: number;
    failed: number;
  } | null>(null);
  const [scheduleBUploadError, setScheduleBUploadError] = useState<string | null>(null);
  const [scheduleBHydrated, setScheduleBHydrated] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [contractIdMappingText, setContractIdMappingText] = useState("");
  const [contractIdMappingCount, setContractIdMappingCount] = useState(0);
  const contractIdMappingRef = useRef<Map<string, string>>(new Map());

  const ensureScheduleBImportJob = trpc.solarRecDashboard.ensureScheduleBImportJob.useMutation();
  const uploadScheduleBFileChunk = trpc.solarRecDashboard.uploadScheduleBFileChunk.useMutation();
  const forceRunScheduleBImport = trpc.solarRecDashboard.forceRunScheduleBImport.useMutation();
  const clearScheduleBImport = trpc.solarRecDashboard.clearScheduleBImport.useMutation();

  const scheduleBStatusQuery = trpc.solarRecDashboard.getScheduleBImportStatus.useQuery(undefined, {
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });

  const scheduleBResultsQuery = trpc.solarRecDashboard.listScheduleBImportResults.useQuery(
    { limit: SCHEDULE_B_MAX_SERVER_ROWS, offset: 0 },
    {
      enabled: Boolean(scheduleBStatusQuery.data?.job),
      refetchInterval:
        scheduleBStatusQuery.data?.job?.status === "running" ||
        scheduleBStatusQuery.data?.job?.status === "queued"
          ? 12_000
          : false,
      refetchOnWindowFocus: true,
    }
  );

  useEffect(() => {
    let cancelled = false;

    const rows = scheduleBResultsQuery.data?.rows;
    if (!rows) {
      if (!scheduleBStatusQuery.isLoading && !cancelled) {
        setScheduleBHydrated(true);
        if (!scheduleBStatusQuery.data?.job) {
          setScheduleBResults([]);
        }
      }
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      const { buildAdjustedSchedule, findFirstTransferEnergyYear } = await import("@/lib/scheduleBScanner");
      const mapped: ScheduleBResultRow[] = rows.map((row) => {
        const extraction: import("@/lib/scheduleBScanner").ScheduleBExtraction = {
          fileName: row.fileName,
          designatedSystemId: row.designatedSystemId ?? null,
          gatsId: row.gatsId ?? null,
          acSizeKw: row.acSizeKw ?? null,
          capacityFactor: row.capacityFactor ?? null,
          contractPrice: row.contractPrice ?? null,
          energizationDate: row.energizationDate ?? null,
          maxRecQuantity: row.maxRecQuantity ?? null,
          deliveryYears: row.deliveryYears ?? [],
          error: row.error ?? null,
        };
        const firstTransferYear = extraction.gatsId
          ? findFirstTransferEnergyYear(extraction.gatsId, transferDeliveryLookup)
          : null;
        const adjustedYears = buildAdjustedSchedule(extraction, firstTransferYear);
        return {
          extraction,
          adjustedYears,
          firstTransferYear,
        };
      });

      if (!cancelled) {
        setScheduleBResults(mapped);
        setScheduleBHydrated(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    scheduleBResultsQuery.data?.rows,
    scheduleBStatusQuery.data?.job,
    scheduleBStatusQuery.isLoading,
    transferDeliveryLookup,
  ]);

  useEffect(() => {
    const processedFiles = scheduleBStatusQuery.data?.counts?.processedFiles ?? 0;
    const loadedResults = scheduleBResultsQuery.data?.total ?? 0;
    if (processedFiles > loadedResults) {
      void scheduleBResultsQuery.refetch();
    }
  }, [
    scheduleBStatusQuery.data?.counts?.processedFiles,
    scheduleBResultsQuery.data?.total,
    scheduleBResultsQuery,
  ]);

  const handleContractIdMappingChange = useCallback(
    async (text: string) => {
      setContractIdMappingText(text);
      const { parseContractIdMapping } = await import("@/lib/scheduleBScanner");
      const mapping = parseContractIdMapping(text);
      contractIdMappingRef.current = mapping;
      setContractIdMappingCount(mapping.size);

      if (mapping.size > 0 && existingDeliverySchedule && existingDeliverySchedule.length > 0) {
        let patched = 0;
        const updatedRows = existingDeliverySchedule.map((row) => {
          const gatsId = (row.tracking_system_ref_id ?? "").toUpperCase();
          const contractId = mapping.get(gatsId);
          if (contractId) {
            patched++;
            return { ...row, utility_contract_number: contractId };
          }
          return row;
        });
        if (patched > 0) {
          onApply(updatedRows);
          toast.success(`Updated ${patched} contract IDs in existing delivery schedule`);
        }
      }
    },
    [existingDeliverySchedule, onApply]
  );

  const uploadSinglePdf = useCallback(
    async (jobId: string, file: File) => {
      const normalizedFileSize = Number.isFinite(file.size) ? Math.trunc(file.size) : 0;
      if (normalizedFileSize < 1) {
        return "empty_file" as const;
      }

      const totalChunks = Math.max(
        1,
        Math.ceil(normalizedFileSize / SCHEDULE_B_UPLOAD_CHUNK_BYTES)
      );
      const uploadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        const start = chunkIndex * SCHEDULE_B_UPLOAD_CHUNK_BYTES;
        const end = Math.min(normalizedFileSize, start + SCHEDULE_B_UPLOAD_CHUNK_BYTES);
        const expectedBytes = Math.max(0, end - start);
        let bytes = new Uint8Array();

        for (
          let readAttempt = 1;
          readAttempt <= SCHEDULE_B_UPLOAD_CHUNK_READ_MAX_ATTEMPTS;
          readAttempt += 1
        ) {
          const blob = file.slice(start, end);
          bytes = new Uint8Array(await blob.arrayBuffer());
          if (expectedBytes === 0 || bytes.length > 0) {
            break;
          }

          if (readAttempt < SCHEDULE_B_UPLOAD_CHUNK_READ_MAX_ATTEMPTS) {
            await waitMs(SCHEDULE_B_UPLOAD_CHUNK_READ_RETRY_BASE_MS * readAttempt);
          }
        }

        if (expectedBytes > 0 && bytes.length === 0) {
          throw new Error(
            `Upload failed for ${file.name} (chunk ${chunkIndex + 1}/${totalChunks}): unable to read file bytes in browser. Re-select this folder and retry.`
          );
        }

        const chunkBase64 = bytesToBase64(bytes);
        if (expectedBytes > 0 && chunkBase64.length === 0) {
          throw new Error(
            `Upload failed for ${file.name} (chunk ${chunkIndex + 1}/${totalChunks}): empty chunk payload produced in browser.`
          );
        }

        let response: Awaited<ReturnType<typeof uploadScheduleBFileChunk.mutateAsync>>;
        try {
          response = await uploadScheduleBFileChunk.mutateAsync({
            jobId,
            uploadId,
            fileName: file.name,
            fileSize: normalizedFileSize,
            chunkIndex,
            totalChunks,
            chunkBase64,
          });
        } catch (error) {
          throw new Error(
            `Upload failed for ${file.name} (chunk ${chunkIndex + 1}/${totalChunks}): ${getErrorMessage(error)}`
          );
        }

        if (
          response.skipped &&
          (response.reason === "already_uploaded" || response.reason === "duplicate_chunk")
        ) {
          return response.reason;
        }
      }

      return "uploaded";
    },
    [uploadScheduleBFileChunk]
  );

  const uploadSinglePdfWithRetry = useCallback(
    async (jobId: string, file: File) => {
      for (let attempt = 1; attempt <= SCHEDULE_B_UPLOAD_FILE_MAX_ATTEMPTS; attempt += 1) {
        try {
          return await uploadSinglePdf(jobId, file);
        } catch (error) {
          if (attempt >= SCHEDULE_B_UPLOAD_FILE_MAX_ATTEMPTS) {
            throw error;
          }
          await waitMs(SCHEDULE_B_UPLOAD_RETRY_BASE_MS * attempt);
        }
      }

      return "uploaded" as const;
    },
    [uploadSinglePdf]
  );

  const handleScheduleBFolder = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;

      const pdfFiles = Array.from(files).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
      if (pdfFiles.length === 0) {
        toast.error("No PDF files found in selected folder");
        return;
      }

      setScheduleBUploading(true);
      setScheduleBProgress({ current: 0, total: 0 });
      setScheduleBUploadSummary(null);
      setScheduleBUploadError(null);

      try {
        const ensured = await ensureScheduleBImportJob.mutateAsync();
        const knownNames = new Set(ensured.knownFileNames.map((name) => name.toLowerCase()));
        const seen = new Set<string>();
        const filesToUpload: File[] = [];
        let alreadyKnownOrDuplicateCount = 0;
        let emptyFileCount = 0;

        for (const file of pdfFiles) {
          const key = file.name.toLowerCase();
          if (seen.has(key)) {
            alreadyKnownOrDuplicateCount += 1;
            continue;
          }
          seen.add(key);
          if (knownNames.has(key)) {
            alreadyKnownOrDuplicateCount += 1;
            continue;
          }
          if (!Number.isFinite(file.size) || file.size < 1) {
            emptyFileCount += 1;
            continue;
          }
          filesToUpload.push(file);
        }

        if (filesToUpload.length === 0) {
          if (alreadyKnownOrDuplicateCount > 0 && emptyFileCount > 0) {
            toast.info(
              `${alreadyKnownOrDuplicateCount} PDFs already queued/processed, ${emptyFileCount} empty file(s) skipped`
            );
          } else if (alreadyKnownOrDuplicateCount > 0) {
            toast.info(`All ${alreadyKnownOrDuplicateCount} PDFs already queued or processed`);
          } else {
            toast.error(`No uploadable PDFs found (${emptyFileCount} empty file(s) skipped)`);
          }
          return;
        }

        let uploadedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;
        const failedMessages: string[] = [];
        setScheduleBProgress({ current: 0, total: filesToUpload.length });

        for (let index = 0; index < filesToUpload.length; index += 1) {
          const file = filesToUpload[index];
          try {
            const result = await uploadSinglePdfWithRetry(ensured.job.id, file);
            if (result === "uploaded") {
              uploadedCount += 1;
            } else {
              skippedCount += 1;
            }
          } catch (error) {
            failedCount += 1;
            const message = getErrorMessage(error);
            failedMessages.push(`${file.name}: ${message}`);
            setScheduleBUploadError(message);
          }
          setScheduleBProgress({ current: index + 1, total: filesToUpload.length });
        }

        await forceRunScheduleBImport.mutateAsync().catch(() => ({ success: false }));
        await Promise.all([
          scheduleBStatusQuery.refetch(),
          scheduleBResultsQuery.refetch(),
        ]);
        await waitMs(1_500);
        await Promise.all([
          scheduleBStatusQuery.refetch(),
          scheduleBResultsQuery.refetch(),
        ]);

        const skippedExisting = alreadyKnownOrDuplicateCount + skippedCount;
        const skippedTotal = skippedExisting + emptyFileCount;
        setScheduleBUploadSummary({
          uploaded: uploadedCount,
          skipped: skippedTotal,
          failed: failedCount,
        });

        if (failedCount > 0) {
          toast.error(
            `Uploaded ${uploadedCount} of ${filesToUpload.length} PDFs. ${failedCount} failed.`
          );
          if (failedMessages.length > 0) {
            setScheduleBUploadError(failedMessages.slice(0, 3).join(" | "));
          }
        } else {
          const summaryParts: string[] = [];
          if (skippedExisting > 0) summaryParts.push(`${skippedExisting} already present`);
          if (emptyFileCount > 0) summaryParts.push(`${emptyFileCount} empty skipped`);
          const msg = summaryParts.length
            ? `Queued ${uploadedCount} new PDFs (${summaryParts.join(", ")})`
            : `Queued ${uploadedCount} Schedule B PDFs for background processing`;
          toast.success(msg);
        }
      } catch (error) {
        const message = getErrorMessage(error);
        setScheduleBUploadError(message);
        toast.error(message);
      } finally {
        setScheduleBUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [
      ensureScheduleBImportJob,
      forceRunScheduleBImport,
      scheduleBResultsQuery,
      setScheduleBUploadError,
      setScheduleBUploadSummary,
      scheduleBStatusQuery,
      uploadSinglePdfWithRetry,
    ]
  );

  const [applyingSchedule, setApplyingSchedule] = useState(false);

  const handleApply = useCallback(async () => {
    setApplyingSchedule(true);
    toast.info("Building delivery schedule from scan results...");
    await new Promise((r) => setTimeout(r, 100));
    try {
      const { toDeliveryScheduleBaseRows } = await import("@/lib/scheduleBScanner");
      const rows = toDeliveryScheduleBaseRows(
        scheduleBResults,
        contractIdMappingRef.current.size > 0 ? contractIdMappingRef.current : undefined
      );
      if (rows.length === 0) {
        toast.error("No valid results to apply");
        return;
      }
      onApply(rows);
      toast.success(`Applied ${rows.length} systems as Delivery Schedule`);
    } finally {
      setApplyingSchedule(false);
    }
  }, [scheduleBResults, onApply]);

  const handleExportCsv = useCallback(() => {
    const headers = [
      "fileName", "designatedSystemId", "gatsId", "acSizeKw",
      "capacityFactor", "contractPrice", "energizationDate",
      "firstTransferYear", "error",
      ...Array.from({ length: 15 }, (_, i) => `year${i + 1}_qty`),
    ];
    const csvRows = scheduleBResults.map((r) => {
      const vals: Record<string, string | number> = {
        fileName: r.extraction.fileName,
        designatedSystemId: r.extraction.designatedSystemId ?? "",
        gatsId: r.extraction.gatsId ?? "",
        acSizeKw: r.extraction.acSizeKw ?? "",
        capacityFactor: r.extraction.capacityFactor ?? "",
        contractPrice: r.extraction.contractPrice ?? "",
        energizationDate: r.extraction.energizationDate ?? "",
        firstTransferYear: r.firstTransferYear ?? "",
        error: r.extraction.error ?? "",
      };
      for (let i = 0; i < 15; i++) {
        vals[`year${i + 1}_qty`] = r.adjustedYears[i]?.recQuantity ?? "";
      }
      return vals;
    });
    const csv = buildCsv(headers, csvRows);
    triggerCsvDownload(`schedule-b-extractions-${timestampForCsvFileName()}.csv`, csv);
  }, [scheduleBResults]);

  const statusCounts = scheduleBStatusQuery.data?.counts;
  const serverJobStatus = scheduleBStatusQuery.data?.job?.status ?? null;
  const backgroundRunning = serverJobStatus === "running" || serverJobStatus === "queued";
  const showUploadProgress = scheduleBProgress.total > 0 || backgroundRunning;
  const successCount = scheduleBResults.filter((r) => !r.extraction.error).length;
  const errorCount = scheduleBResults.filter((r) => !!r.extraction.error).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">Schedule B PDF Import</CardTitle>
              <Badge variant="secondary">Cloud-backed</Badge>
              {backgroundRunning ? <Badge variant="outline">Processing in background</Badge> : null}
            </div>
            <CardDescription>
              Select a folder of Schedule B PDFs to extract 15-year delivery schedules.
              Uploads and processing persist on the server, so parsing continues if the browser crashes.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {(scheduleBResults.length > 0 || scheduleBStatusQuery.data?.job) && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      await clearScheduleBImport.mutateAsync();
                      await Promise.all([
                        scheduleBStatusQuery.refetch(),
                        scheduleBResultsQuery.refetch(),
                      ]);
                      setScheduleBResults([]);
                      setScheduleBProgress({ current: 0, total: 0 });
                      toast.info("Cleared Schedule B results");
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "Failed to clear Schedule B results");
                    }
                  }}
                >
                  Clear
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await forceRunScheduleBImport.mutateAsync().catch(() => ({ success: false }));
                    await scheduleBStatusQuery.refetch();
                    toast.success("Triggered Schedule B background sync");
                  }}
                  disabled={forceRunScheduleBImport.isPending}
                >
                  {forceRunScheduleBImport.isPending ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      Syncing...
                    </>
                  ) : (
                    "Force Sync"
                  )}
                </Button>
                <Button variant="outline" size="sm" onClick={handleExportCsv}>
                  Export CSV
                </Button>
                <Button size="sm" onClick={handleApply} disabled={applyingSchedule}>
                  {applyingSchedule ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      Applying...
                    </>
                  ) : (
                    `Apply as Delivery Schedule (${successCount})`
                  )}
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is not in the TS type defs
            webkitdirectory=""
            directory=""
            multiple
            accept=".pdf"
            className="hidden"
            onChange={(e) => handleScheduleBFolder(e.target.files)}
          />
          <Button
            variant="outline"
            disabled={scheduleBUploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {scheduleBUploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Uploading {scheduleBProgress.current}/{scheduleBProgress.total}
              </>
            ) : (
              "Select Folder"
            )}
          </Button>

          {showUploadProgress && (
            <div className="flex-1 space-y-1">
              {scheduleBUploading ? (
                <>
                  <Progress
                    value={
                      scheduleBProgress.total > 0
                        ? (scheduleBProgress.current / scheduleBProgress.total) * 100
                        : 0
                    }
                    className="h-3"
                  />
                  <p className="text-xs text-muted-foreground">
                    Uploaded {scheduleBProgress.current} of {scheduleBProgress.total} PDFs
                    {" "}
                    ({Math.round((scheduleBProgress.current / Math.max(1, scheduleBProgress.total)) * 100)}%)
                  </p>
                  {(statusCounts?.totalFiles ?? 0) > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Server processed {statusCounts?.processedFiles ?? 0} of {statusCounts?.totalFiles ?? 0} queued PDFs
                      {" "}
                      ({Math.round(((statusCounts?.processedFiles ?? 0) / Math.max(1, statusCounts?.totalFiles ?? 0)) * 100)}%)
                      {scheduleBStatusQuery.data?.job?.currentFileName
                        ? ` — ${scheduleBStatusQuery.data.job.currentFileName}`
                        : ""}
                    </p>
                  )}
                </>
              ) : backgroundRunning ? (
                <>
                  <Progress
                    value={
                      (statusCounts?.totalFiles ?? 0) > 0
                        ? ((statusCounts?.processedFiles ?? 0) / Math.max(1, statusCounts?.totalFiles ?? 0)) * 100
                        : 0
                    }
                    className="h-3"
                  />
                  <p className="text-xs text-muted-foreground">
                    Processed {statusCounts?.processedFiles ?? 0} of {statusCounts?.totalFiles ?? 0} PDFs
                    {" "}
                    ({Math.round(((statusCounts?.processedFiles ?? 0) / Math.max(1, statusCounts?.totalFiles ?? 0)) * 100)}%)
                    {scheduleBStatusQuery.data?.job?.currentFileName
                      ? ` — ${scheduleBStatusQuery.data.job.currentFileName}`
                      : ""}
                  </p>
                </>
              ) : (
                <>
                  <Progress value={100} className="h-3" />
                  <p className="text-xs text-muted-foreground">
                    Upload complete: {scheduleBUploadSummary?.uploaded ?? scheduleBProgress.current} uploaded
                    {scheduleBUploadSummary ? `, ${scheduleBUploadSummary.skipped} skipped` : ""}
                    {scheduleBUploadSummary ? `, ${scheduleBUploadSummary.failed} failed` : ""}
                  </p>
                </>
              )}
            </div>
          )}

          {!scheduleBUploading && scheduleBResults.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {successCount} extracted, {errorCount} errors{scheduleBHydrated ? " (restored from cloud)" : ""}
            </span>
          )}
        </div>

        {scheduleBStatusQuery.data?.job?.error ? (
          <p className="text-xs text-red-600">
            Status error: {scheduleBStatusQuery.data.job.error}
          </p>
        ) : null}

        {scheduleBUploadError ? (
          <p className="text-xs text-red-600">
            Upload error: {scheduleBUploadError}
          </p>
        ) : null}

        {scheduleBResults.length > 0 && (
          <div className="rounded-md border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider">GATS ID to Contract ID Mapping</p>
                <p className="text-xs text-muted-foreground">
                  Paste two columns: GATS ID and Contract Number (CSV, tab, or one per line).
                </p>
              </div>
              {contractIdMappingCount > 0 && (
                <span className="text-xs font-semibold text-green-600 dark:text-green-400">
                  {contractIdMappingCount} mapped
                </span>
              )}
            </div>
            <textarea
              value={contractIdMappingText}
              onChange={(e) => handleContractIdMappingChange(e.target.value)}
              placeholder={"NON426617,493\nNON427890,512\nNON428123,515"}
              rows={3}
              className="w-full rounded-sm border bg-background px-2 py-1.5 text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        )}

        {scheduleBResults.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ABP ID</TableHead>
                  <TableHead>GATS ID</TableHead>
                  <TableHead className="text-right">AC kW</TableHead>
                  <TableHead className="text-right">Cap Factor</TableHead>
                  <TableHead>1st Transfer EY</TableHead>
                  {Array.from({ length: 15 }, (_, i) => (
                    <TableHead key={i} className="text-right text-xs">
                      Y{i + 1}
                    </TableHead>
                  ))}
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scheduleBResults.slice(0, 100).map((r, idx) => (
                  <TableRow
                    key={`${r.extraction.fileName}-${idx}`}
                    className={r.extraction.error ? "bg-red-50/50" : ""}
                  >
                    <TableCell className="font-mono text-xs">
                      {r.extraction.designatedSystemId ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.extraction.gatsId ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {r.extraction.acSizeKw ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {r.extraction.capacityFactor != null
                        ? `${(r.extraction.capacityFactor * 100).toFixed(2)}%`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.firstTransferYear
                        ? `${r.firstTransferYear}-${r.firstTransferYear + 1}`
                        : "—"}
                    </TableCell>
                    {Array.from({ length: 15 }, (_, i) => {
                      const year = r.adjustedYears[i];
                      return (
                        <TableCell
                          key={i}
                          className={`text-right text-xs ${
                            year?.source === "calculated"
                              ? "text-blue-600"
                              : ""
                          }`}
                        >
                          {year?.recQuantity ?? "—"}
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-xs text-red-600 max-w-[150px] truncate">
                      {r.extraction.error ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
