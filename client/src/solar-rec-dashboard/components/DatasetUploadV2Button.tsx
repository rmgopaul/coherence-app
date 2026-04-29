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
 *   - "Upload (v2)" button → opens hidden file picker
 *   - On file selected → kicks off the controller's startUpload
 *   - Mounts <UploadProgressDialog> while the upload + parsing run
 *   - On terminal status, dialog stays open until the user closes
 *     it (and clicks "Refresh dashboard" on success)
 *
 * The ONE caller in this PR is the contractedDate slot in
 * `SolarRecDashboard.tsx`'s Step 1 panel. Phase 4 will add this
 * button to the other 17 slots once their parsers are wired.
 */
import { useCallback, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { convertSpreadsheetFileToCsv } from "@/lib/csvParsing";
import { useDatasetUploadController } from "../hooks/useDatasetUploadController";
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
   * their CSV-only UX.
   */
  acceptExcel?: boolean;
}

export function DatasetUploadV2Button({
  datasetKey,
  onSuccess,
  label = "Upload (v2)",
  variant = "default",
  compact = false,
  disabled = false,
  acceptExcel = false,
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

  const handlePick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const picked = event.target.files?.[0];
      // Reset the input so picking the same file twice fires
      // onChange the second time too.
      event.currentTarget.value = "";
      if (!picked) return;

      setPrepError(null);
      let fileToUpload: File = picked;
      if (acceptExcel) {
        // `convertSpreadsheetFileToCsv` is a no-op for .csv inputs
        // and parses Excel via the existing `parseTabularFile` helper
        // for the 4 supported extensions. We always call it under
        // `acceptExcel` so a user dropping a stray .xlsx onto the
        // CSV-only `<input>` (which can happen on macOS with
        // `accept` filtering bypassed) gets the same conversion path
        // rather than a 500 from the server-side CSV parser.
        setIsPreparingFile(true);
        try {
          fileToUpload = await convertSpreadsheetFileToCsv(picked, {
            excelSheetMode: "first",
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          setPrepError(message);
          setIsPreparingFile(false);
          return;
        }
        setIsPreparingFile(false);
      }

      const result = await controller.startUpload(datasetKey, fileToUpload);
      // Even on failure, surface the dialog so the user sees the
      // error state — `controller.state.error` is the source of
      // truth pre-finalize. result?.jobId only exists post-finalize
      // success; the dialog keys off jobId for status polling but
      // also reads `controllerState` for the pre-jobId phase.
      setDialogJobId(result?.jobId ?? null);
    },
    [acceptExcel, controller, datasetKey]
  );

  const handleClose = useCallback(() => {
    setDialogJobId(null);
    controller.reset();
  }, [controller]);

  const handleRefresh = useCallback(() => {
    if (dialogJobId && onSuccess) onSuccess(dialogJobId);
    setDialogJobId(null);
    controller.reset();
  }, [controller, dialogJobId, onSuccess]);

  const handleRetry = useCallback(() => {
    setDialogJobId(null);
    controller.reset();
    // Re-open the file picker so the user can choose a fresh file
    // (the previous file is the most likely culprit for a parse
    // failure).
    inputRef.current?.click();
  }, [controller]);

  const isWorking =
    isPreparingFile ||
    controller.state.phase === "starting" ||
    controller.state.phase === "uploading" ||
    controller.state.phase === "finalizing";

  // The dialog renders when EITHER the controller has any non-idle
  // state to show OR a jobId is being polled. The `controllerState`
  // prop carries pre-finalize info; the jobId carries post-finalize.
  // (Note: `isPreparingFile` is intentionally NOT a trigger here —
  // a failed Excel parse should not strand an empty dialog; it
  // surfaces inline via the `prepError` chip below.)
  const showDialog =
    dialogJobId !== null ||
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
          onClose={handleClose}
          onRefresh={handleRefresh}
          onRetry={handleRetry}
        />
      )}
    </>
  );
}
