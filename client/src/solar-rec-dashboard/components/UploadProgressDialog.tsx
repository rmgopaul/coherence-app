/**
 * Phase 2 of the IndexedDB-removal refactor — upload progress
 * dialog. Renders the full lifecycle of a server-side dataset
 * upload:
 *
 *   1. Client-side chunk upload (driven by
 *      `useDatasetUploadController`)
 *   2. Server-side parsing / writing (observed via
 *      `useDatasetUploadStatus` polling
 *      `getDatasetUploadStatus` every 2s)
 *   3. Terminal `done` / `failed` state with appropriate
 *      affordances (refresh / retry / dismiss)
 *
 * The dialog is dumb in the sense that it doesn't *start* an
 * upload — its parent does (typically via a file-input + a
 * `useDatasetUploadController().startUpload` call). Once the
 * controller hands back a jobId, the dialog opens with that
 * jobId and watches it. This separation lets a future "Recent
 * uploads" list reopen the dialog for any past job by jobId
 * alone.
 *
 * No data fetching / state mutation happens in the dialog itself
 * beyond the polling query — invalidation of dashboard caches on
 * success is the parent's responsibility (because only the parent
 * knows which queries the just-uploaded dataset affects).
 */
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  formatEstimatedRemaining,
  formatUploadProgress,
  isTerminalUploadStatus,
} from "@shared/datasetUpload.helpers";
import { useDatasetUploadStatus } from "../hooks/useDatasetUploadStatus";
import type { DatasetUploadControllerState } from "../hooks/useDatasetUploadController";

export interface UploadProgressDialogProps {
  /**
   * jobId of the upload to watch. Null = no job yet (dialog
   * shouldn't render). The parent component owns this state via
   * `useDatasetUploadController`.
   */
  jobId: string | null;
  /**
   * Pre-finalize phase from the controller. Drives the progress
   * bar during the upload portion (the server doesn't see
   * uploadedChunks until each chunk POST lands, so the controller
   * is the more responsive source of truth here).
   */
  controllerState?: DatasetUploadControllerState;
  /**
   * Called when the dialog should close — both for explicit
   * dismissal and after the user clicks "Refresh dashboard".
   */
  onClose: () => void;
  /**
   * Called when the user clicks "Refresh dashboard" on a
   * successful upload. The parent should invalidate the relevant
   * dataset queries (typically all of them — datasets cross-
   * reference each other through srDs* joins).
   */
  onRefresh?: () => void;
  /**
   * Called when the user clicks "Try again" on a failed upload.
   * The parent should re-open the file picker, NOT just retry
   * the same job (the underlying file may have been the
   * problem).
   */
  onRetry?: () => void;
  /**
   * Optional title override. Defaults to "Uploading {datasetKey}"
   * once the status query resolves.
   */
  titleOverride?: string;
}

export function UploadProgressDialog({
  jobId,
  controllerState,
  onClose,
  onRefresh,
  onRetry,
  titleOverride,
}: UploadProgressDialogProps) {
  // Re-render every second so the ETA stays current — the poll
  // only fires every 2s, but ETA is a function of the elapsed
  // wall-clock time too.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const statusQuery = useDatasetUploadStatus(jobId);
  const job = statusQuery.data?.job;
  const errors = statusQuery.data?.errors ?? [];

  // The progress view-model is the union of the controller's
  // pre-finalize state and the server's post-finalize state.
  // Until the server sees the first chunk, the controller is the
  // only source of progress info.
  const progressView = useMemo(() => {
    if (job) {
      return formatUploadProgress(
        {
          status: job.status,
          totalRows: job.totalRows ?? null,
          rowsParsed: job.rowsParsed ?? 0,
          rowsWritten: job.rowsWritten ?? 0,
          uploadedChunks: job.uploadedChunks ?? 0,
          totalChunks: job.totalChunks ?? null,
          startedAt: job.startedAt ?? null,
          completedAt: job.completedAt ?? null,
          errorMessage: job.errorMessage ?? null,
        },
        now
      );
    }
    if (controllerState) {
      // Map controller phase → server-shaped status for the
      // formatter. `starting` → queued; `uploading` → uploading;
      // `finalizing` → parsing (close enough for UI purposes).
      const mappedStatus =
        controllerState.phase === "starting"
          ? "queued"
          : controllerState.phase === "uploading"
            ? "uploading"
            : controllerState.phase === "finalizing"
              ? "parsing"
              : controllerState.phase === "failed"
                ? "failed"
                : controllerState.phase === "cancelled"
                  ? "failed"
                  : "queued";
      return formatUploadProgress(
        {
          status: mappedStatus,
          totalRows: null,
          rowsParsed: 0,
          rowsWritten: 0,
          uploadedChunks: controllerState.uploadedChunks,
          totalChunks: controllerState.totalChunks,
          startedAt: null,
          completedAt: null,
          errorMessage:
            controllerState.phase === "cancelled"
              ? "Upload cancelled."
              : controllerState.error,
        },
        now
      );
    }
    return null;
  }, [job, controllerState, now]);

  const open = jobId !== null || controllerState != null;
  const datasetKey = job?.datasetKey;
  const title =
    titleOverride ??
    (datasetKey ? `Uploading ${datasetKey}` : "Uploading dataset");

  const isTerminal = job ? isTerminalUploadStatus(job.status) : false;
  const isCancelled = controllerState?.phase === "cancelled";
  const showSuccess = job?.status === "done";
  const showFailure = job?.status === "failed" || isCancelled;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        // Prevent escape / outside-click dismiss while the
        // upload is in-flight — the user might lose their place
        // in the upload by accident.
        onInteractOutside={(event) => {
          if (!isTerminal && !isCancelled) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (!isTerminal && !isCancelled) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {showSuccess ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            ) : showFailure ? (
              <XCircle className="h-5 w-5 text-rose-600" />
            ) : (
              <Loader2 className="h-5 w-5 animate-spin" />
            )}
            <span>{title}</span>
          </DialogTitle>
          {progressView && (
            <DialogDescription>
              {progressView.stageLabel}
              {progressView.detailLabel ? ` · ${progressView.detailLabel}` : ""}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-3">
          {progressView && !showFailure && !showSuccess && (
            <>
              <Progress value={Math.round((progressView.pct ?? 0) * 100)} />
              {progressView.estimatedRemainingMs != null &&
                progressView.estimatedRemainingMs > 0 && (
                  <p className="text-xs text-muted-foreground">
                    About {formatEstimatedRemaining(progressView.estimatedRemainingMs)} remaining
                  </p>
                )}
            </>
          )}

          {showSuccess && job && (
            <div className="text-sm text-muted-foreground">
              {job.rowsWritten?.toLocaleString() ?? 0} rows written.
              {job.totalRows != null && job.rowsWritten != null &&
                job.totalRows > job.rowsWritten && (
                  <>
                    {" "}
                    {job.totalRows - job.rowsWritten} rows skipped — see
                    error list below.
                  </>
                )}
            </div>
          )}

          {showFailure && (
            <div className="text-sm text-rose-700">
              {job?.errorMessage ??
                controllerState?.error ??
                "Upload cancelled."}
            </div>
          )}

          {errors.length > 0 && (
            <details className="rounded-md border bg-muted/30 p-2 text-xs">
              <summary className="cursor-pointer font-medium">
                Row errors ({errors.length})
              </summary>
              <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                {errors.slice(0, 50).map((e) => (
                  <li key={e.id}>
                    <Badge variant="outline" className="mr-2">
                      Row {e.rowIndex == null ? "?" : e.rowIndex + 1}
                    </Badge>
                    <span className="text-muted-foreground">
                      {e.errorMessage}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {showSuccess ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              {onRefresh && (
                <Button onClick={onRefresh}>Refresh dashboard</Button>
              )}
            </>
          ) : showFailure ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              {onRetry && <Button onClick={onRetry}>Try again</Button>}
            </>
          ) : (
            <Button variant="outline" onClick={onClose} disabled>
              Working…
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
