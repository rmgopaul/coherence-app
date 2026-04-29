/**
 * Phase 3 of the IndexedDB-removal refactor — drop-in replacement
 * for the legacy "Choose CSV" file input on a single dataset slot.
 *
 * Wraps the controller hook + the progress dialog into a single
 * compound widget with a stable API:
 *
 *   <DatasetUploadV2Button
 *     datasetKey="contractedDate"
 *     onSuccess={(jobId) => invalidateRelevantQueries()}
 *   />
 *
 * Shows:
 *   - Upload button → opens hidden file picker
 *   - On file selected → kicks off the controller's startUpload
 *   - Mounts <UploadProgressDialog> while the upload + parsing run
 *   - On terminal status, dialog stays open until the user closes
 *     it (and clicks "Refresh dashboard" on success)
 *
 * Phase 6 PR-A added Excel input support (`acceptExcel`).
 * Phase 6 PR-B-2 (this file) adds multi-file pick + sequential
 * upload (`acceptMultiple`) so the 3 multi-append datasets
 * (`accountSolarGeneration`, `convertedReads`, `transferHistory`)
 * regain the multi-file UX they had under v1, now driven by the
 * server-side append mode shipped in Phase 6 PR-B (#253).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { convertSpreadsheetFileToCsv } from "@/lib/csvParsing";
import { useDatasetUploadController } from "../hooks/useDatasetUploadController";
import { useDatasetUploadStatus } from "../hooks/useDatasetUploadStatus";
import { UploadProgressDialog } from "./UploadProgressDialog";

export interface DatasetUploadV2ButtonProps {
  datasetKey: string;
  /**
   * Called when the upload reaches the `done` status (parser
   * finished, batchId activated). Parent should invalidate the
   * tRPC queries the dashboard reads for this dataset.
   *
   * `jobId` is provided so the parent can correlate with any
   * tracking it does (analytics, recent-uploads list, etc.).
   *
   * Multi-file mode: fires ONCE when the user clicks "Refresh
   * dashboard" after the LAST file has reached `done`. The
   * `jobId` passed is the last file's id. The other files'
   * jobIds are not surfaced to the parent — they all wrote to
   * the same active batch via append mode, so a single refresh
   * covers all of them.
   */
  onSuccess?: (jobId: string) => void;
  /** Lets the parent override the button label. Defaults to "Upload (v2)". */
  label?: string;
  /** Visual style. Defaults to "default" (filled). */
  variant?: "default" | "outline" | "secondary";
  /** Compact mode — same h-7 / text-xs sizing the dashboard uses elsewhere. */
  compact?: boolean;
  disabled?: boolean;
  /**
   * Phase 6 PR-A — opt into Excel (`.xlsx/.xlsm/.xlsb/.xls`) input
   * for datasets that historically supported it on the legacy v1
   * path (`abpIccReport2Rows`, `abpIccReport3Rows`). When true, the
   * button widens its `<input accept>` and converts the Excel file
   * to CSV in the browser via `convertSpreadsheetFileToCsv` before
   * handing the bytes to the controller. The server runner is
   * unchanged — it still receives a CSV.
   *
   * Defaults to `false` so the other 15 v2-enabled datasets keep
   * their CSV-only UX. Mutually exclusive with `acceptMultiple`
   * in practice (no dataset key is both Excel-tabular and
   * multi-append).
   */
  acceptExcel?: boolean;
  /**
   * Phase 6 PR-B-2 — opt into multi-file picker. Wires
   * `multiple` on the hidden `<input>`. When the user picks N
   * files, they upload sequentially (file 1 → wait for server
   * `done` status → file 2 → …). The 3 multi-append datasets
   * (`accountSolarGeneration`, `convertedReads`,
   * `transferHistory`) use this; the server runner's append mode
   * (Phase 6 PR-B, #253) dedups across batches so the 3rd
   * upload of an overlapping file is a no-op rather than a
   * truncate.
   *
   * Sequential (not concurrent) because the runner's batch-
   * activation step races on (scopeId, datasetKey): two
   * concurrent appends could superseded each other mid-write.
   * Slower-but-safe is the right tradeoff here.
   *
   * Defaults to `false`.
   */
  acceptMultiple?: boolean;
}

interface MultiFileBatch {
  /** Every file the user picked, in pick order. */
  files: File[];
  /** Index of the file currently uploading. */
  currentIndex: number;
  /** jobIds of files that have already reached server `done`. */
  completedJobIds: string[];
}

export function DatasetUploadV2Button({
  datasetKey,
  onSuccess,
  label = "Upload (v2)",
  variant = "default",
  compact = false,
  disabled = false,
  acceptExcel = false,
  acceptMultiple = false,
}: DatasetUploadV2ButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const controller = useDatasetUploadController();
  const [dialogJobId, setDialogJobId] = useState<string | null>(null);
  // Phase 6 PR-A — Excel-conversion error surfaces inline on the
  // button (not in the upload dialog), because conversion runs
  // BEFORE the controller starts; the dialog only opens once the
  // controller is in a non-idle phase. A failed parse therefore
  // never produces a job row and never reaches the dialog. The
  // chip clears on the next pick attempt.
  const [prepError, setPrepError] = useState<string | null>(null);
  const [isPreparingFile, setIsPreparingFile] = useState(false);
  // Phase 6 PR-B-2 — null in single-file mode; non-null while a
  // multi-file batch is in progress.
  const [multiFileBatch, setMultiFileBatch] = useState<MultiFileBatch | null>(
    null
  );
  // Guard against the advance effect double-firing when state
  // updates re-trigger it after we've already moved on from a
  // given jobId.
  const lastAdvancedJobIdRef = useRef<string | null>(null);

  // Watch the active job's server status. The dialog ALSO calls
  // this hook with the same jobId; React Query dedupes the query
  // by key, so this is a free observation — no extra polling.
  const statusQuery = useDatasetUploadStatus(dialogJobId);
  const serverStatus = statusQuery.data?.job?.status ?? null;

  /**
   * Centralised file-upload kickoff. Handles the optional Excel
   * conversion, then drives one round of
   * `controller.startUpload`. Returns the resulting jobId, or
   * null on failure (Excel parse, controller error). The
   * controller's own state machine surfaces the failure to the
   * dialog if the controller itself was reached.
   */
  const uploadOneFile = useCallback(
    async (file: File): Promise<string | null> => {
      let fileToUpload = file;
      if (acceptExcel) {
        // `convertSpreadsheetFileToCsv` is a no-op for .csv inputs
        // and parses Excel via the existing `parseTabularFile` helper
        // for the 4 supported extensions.
        setIsPreparingFile(true);
        try {
          fileToUpload = await convertSpreadsheetFileToCsv(file, {
            excelSheetMode: "first",
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setPrepError(message);
          setIsPreparingFile(false);
          return null;
        }
        setIsPreparingFile(false);
      }
      const result = await controller.startUpload(datasetKey, fileToUpload);
      return result?.jobId ?? null;
    },
    [acceptExcel, controller, datasetKey]
  );

  const handlePick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const filesArray = Array.from(event.target.files ?? []);
      // Reset the input so picking the same file twice fires
      // onChange the second time too.
      event.currentTarget.value = "";
      if (filesArray.length === 0) return;

      setPrepError(null);
      lastAdvancedJobIdRef.current = null;

      // Single-file path: existing behaviour. Either the dataset
      // is single-file by config, or the user picked exactly one
      // file even though multi was allowed.
      if (filesArray.length === 1 || !acceptMultiple) {
        const jobId = await uploadOneFile(filesArray[0]);
        setDialogJobId(jobId);
        return;
      }

      // Multi-file path: kick off file 0, set batch state. The
      // advance-loop effect below picks up from there once the
      // server reports the current job as `done`.
      const firstJobId = await uploadOneFile(filesArray[0]);
      setMultiFileBatch({
        files: filesArray,
        currentIndex: 0,
        completedJobIds: [],
      });
      setDialogJobId(firstJobId);
    },
    [acceptMultiple, uploadOneFile]
  );

  // Phase 6 PR-B-2 — sequential advance loop. When the active
  // job's server status reaches `done` AND we're in a multi-file
  // batch, kick off the next file. When the LAST file reaches
  // `done`, leave the dialog on its success state — the user
  // clicks "Refresh dashboard" to fire onSuccess (single call,
  // last jobId).
  //
  // On a `failed` status mid-batch, we stop advancing. Files
  // already in `completedJobIds` are durable on the server (their
  // batches were activated). The user can retry from a fresh pick
  // — the runner's append mode dedups overlap.
  useEffect(() => {
    if (!multiFileBatch) return;
    if (serverStatus !== "done") return;
    if (!dialogJobId) return;
    if (lastAdvancedJobIdRef.current === dialogJobId) return;
    lastAdvancedJobIdRef.current = dialogJobId;

    const completedSoFar = [...multiFileBatch.completedJobIds, dialogJobId];
    const nextIndex = multiFileBatch.currentIndex + 1;

    if (nextIndex >= multiFileBatch.files.length) {
      // Last file done. Record the completion but DON'T clear the
      // batch yet — handleRefresh will fire onSuccess and clear.
      // handleClose also clears.
      setMultiFileBatch({ ...multiFileBatch, completedJobIds: completedSoFar });
      return;
    }

    // Next file. Snapshot the batch update; the in-flight
    // controller call will set dialogJobId on completion.
    const nextFile = multiFileBatch.files[nextIndex];
    setMultiFileBatch({
      ...multiFileBatch,
      currentIndex: nextIndex,
      completedJobIds: completedSoFar,
    });
    void uploadOneFile(nextFile).then((nextJobId) => {
      setDialogJobId(nextJobId);
    });
  }, [serverStatus, dialogJobId, multiFileBatch, uploadOneFile]);

  const handleClose = useCallback(() => {
    setDialogJobId(null);
    setMultiFileBatch(null);
    lastAdvancedJobIdRef.current = null;
    controller.reset();
  }, [controller]);

  const handleRefresh = useCallback(() => {
    if (dialogJobId && onSuccess) onSuccess(dialogJobId);
    setDialogJobId(null);
    setMultiFileBatch(null);
    lastAdvancedJobIdRef.current = null;
    controller.reset();
  }, [controller, dialogJobId, onSuccess]);

  const handleRetry = useCallback(() => {
    setDialogJobId(null);
    setMultiFileBatch(null);
    lastAdvancedJobIdRef.current = null;
    controller.reset();
    // Re-open the file picker so the user can choose a fresh
    // file (the previous file is the most likely culprit for a
    // parse failure). For multi-file batches that failed
    // mid-stream, prior files are already durable; the picker is
    // effectively a "pick the remaining files" affordance.
    inputRef.current?.click();
  }, [controller]);

  const isWorking =
    isPreparingFile ||
    multiFileBatch !== null ||
    controller.state.phase === "starting" ||
    controller.state.phase === "uploading" ||
    controller.state.phase === "finalizing";

  // Dialog renders when ANY of: a job is being polled, the
  // controller is in a transient phase, OR a multi-file batch is
  // active (gives us a stable surface across the brief gap
  // between file N's `done` and file N+1's `startUpload`
  // returning a new jobId).
  //
  // `isPreparingFile` is intentionally NOT a trigger — a failed
  // Excel parse should not strand an empty dialog; it surfaces
  // inline via the `prepError` chip below.
  const showDialog =
    dialogJobId !== null ||
    multiFileBatch !== null ||
    (controller.state.phase !== "idle" && controller.state.phase !== "done");

  // ARIA + visible label: when the user drops an Excel file in,
  // briefly say "Preparing…" instead of the regular label so the
  // disabled state has a reason. Falls back to the configured
  // label otherwise.
  const buttonLabel = isPreparingFile ? "Preparing…" : label;

  // CSV-only by default, widened on a per-dataset basis when the
  // legacy v1 path used to take Excel for that key. We mirror v1's
  // exact `accept` string for the Excel-enabled case so the file
  // picker behaves identically on the OS picker.
  const acceptString = acceptExcel
    ? ".csv,.xlsx,.xls,.xlsm,.xlsb,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : ".csv,text/csv";

  // Title override for multi-file mode — surfaces "file 2 of 5:
  // <fileName>" at the top of the dialog so the user knows
  // there's more to come. For single-file uploads we leave it
  // undefined and the dialog falls back to "Uploading
  // {datasetKey}".
  const dialogTitleOverride = (() => {
    if (!multiFileBatch) return undefined;
    const total = multiFileBatch.files.length;
    const human = multiFileBatch.currentIndex + 1;
    const currentFile = multiFileBatch.files[multiFileBatch.currentIndex];
    const fileName = currentFile?.name ?? "";
    return `Uploading file ${human} of ${total}${fileName ? ` — ${fileName}` : ""}`;
  })();

  return (
    <>
      <Button
        variant={variant}
        size={compact ? "sm" : "default"}
        onClick={handlePick}
        disabled={disabled || isWorking}
        className={compact ? "h-7 px-2 text-xs" : undefined}
      >
        {isWorking ? (
          <Loader2
            className={
              compact ? "mr-1 h-3 w-3 animate-spin" : "mr-2 h-4 w-4 animate-spin"
            }
          />
        ) : (
          <Upload
            className={compact ? "mr-1 h-3 w-3" : "mr-2 h-4 w-4"}
          />
        )}
        {buttonLabel}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={acceptString}
        multiple={acceptMultiple}
        className="hidden"
        onChange={handleFileSelected}
      />
      {prepError ? (
        <p
          role="alert"
          className={
            compact
              ? "text-[11px] text-rose-700"
              : "text-xs text-rose-700"
          }
        >
          {prepError}
        </p>
      ) : null}
      {showDialog && (
        <UploadProgressDialog
          jobId={dialogJobId}
          controllerState={controller.state}
          titleOverride={dialogTitleOverride}
          onClose={handleClose}
          onRefresh={handleRefresh}
          onRetry={handleRetry}
        />
      )}
    </>
  );
}
