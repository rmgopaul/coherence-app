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
}

export function DatasetUploadV2Button({
  datasetKey,
  onSuccess,
  label = "Upload (v2)",
  variant = "default",
  compact = false,
  disabled = false,
}: DatasetUploadV2ButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const controller = useDatasetUploadController();
  const [dialogJobId, setDialogJobId] = useState<string | null>(null);

  const handlePick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset the input so picking the same file twice fires
      // onChange the second time too.
      event.currentTarget.value = "";
      if (!file) return;

      const result = await controller.startUpload(datasetKey, file);
      // Even on failure, surface the dialog so the user sees the
      // error state — `controller.state.error` is the source of
      // truth pre-finalize. result?.jobId only exists post-finalize
      // success; the dialog keys off jobId for status polling but
      // also reads `controllerState` for the pre-jobId phase.
      setDialogJobId(result?.jobId ?? null);
    },
    [controller, datasetKey]
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
    controller.state.phase === "starting" ||
    controller.state.phase === "uploading" ||
    controller.state.phase === "finalizing";

  // The dialog renders when EITHER the controller has any non-idle
  // state to show OR a jobId is being polled. The `controllerState`
  // prop carries pre-finalize info; the jobId carries post-finalize.
  const showDialog =
    dialogJobId !== null ||
    (controller.state.phase !== "idle" && controller.state.phase !== "done");

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
        {label}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={handleFileSelected}
      />
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
