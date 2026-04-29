/**
 * Phase 2 of the IndexedDB-removal refactor — client-side upload
 * controller. Drives the chunked-base64 upload from a `File` to
 * the new server-side runner via three tRPC procs:
 *
 *   1. `solarRecDashboard.startDatasetUpload` → reserves a job +
 *      uploadId
 *   2. `solarRecDashboard.uploadDatasetChunk` (loop) → streams
 *      the file's bytes in base64 chunks
 *   3. `solarRecDashboard.finalizeDatasetUpload` → spawns the
 *      server-side runner; returns immediately
 *
 * The hook is cancellable — calling `cancel()` halts the chunk
 * loop before the next iteration. (A cancellation mid-chunk means
 * the half-uploaded file stays on disk but never gets parsed,
 * which is harmless — the job's status stays `uploading` and the
 * cleanup cron will sweep it later.)
 *
 * Status polling lives in `useDatasetUploadStatus` so the dialog
 * can keep watching the job after this hook's `startUpload` has
 * returned.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
import {
  computeUploadChunkPlan,
  type UploadChunkPlanItem,
} from "@shared/datasetUpload.helpers";

export type DatasetUploadControllerPhase =
  | "idle"
  | "starting"
  | "uploading"
  | "finalizing"
  | "done"
  | "failed"
  | "cancelled";

export interface DatasetUploadControllerState {
  phase: DatasetUploadControllerPhase;
  jobId: string | null;
  uploadId: string | null;
  uploadedChunks: number;
  totalChunks: number;
  error: string | null;
}

export interface UseDatasetUploadControllerResult {
  state: DatasetUploadControllerState;
  startUpload: (
    datasetKey: string,
    file: File
  ) => Promise<{ jobId: string } | null>;
  cancel: () => void;
  reset: () => void;
}

const INITIAL_STATE: DatasetUploadControllerState = {
  phase: "idle",
  jobId: null,
  uploadId: null,
  uploadedChunks: 0,
  totalChunks: 0,
  error: null,
};

/**
 * Convert a Blob slice to a base64 string (no `data:` prefix).
 * Uses FileReader so it works in every browser the dashboard
 * supports without a Buffer polyfill. Fails the promise on
 * decode error so the controller can surface the message.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string") {
        reject(new Error("FileReader returned non-string result"));
        return;
      }
      const comma = dataUrl.indexOf(",");
      if (comma < 0) {
        reject(new Error("FileReader result missing data-URL prefix"));
        return;
      }
      resolve(dataUrl.slice(comma + 1));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

export function useDatasetUploadController(): UseDatasetUploadControllerResult {
  const [state, setState] = useState<DatasetUploadControllerState>(INITIAL_STATE);
  const cancelTokenRef = useRef({ cancelled: false });
  const isMountedRef = useRef(true);

  // Hold trpc client across renders for the imperative call path.
  // `useUtils().client` exposes the tRPC client whose `mutate`
  // method runs without React-Query state ceremony — the right fit
  // for chunk-loop dispatch (we don't want every chunk to bump a
  // useMutation state cycle).
  const utils = solarRecTrpc.useUtils();

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      cancelTokenRef.current.cancelled = true;
    };
  }, []);

  const safeSetState = useCallback(
    (updater: (prev: DatasetUploadControllerState) => DatasetUploadControllerState) => {
      if (!isMountedRef.current) return;
      setState(updater);
    },
    []
  );

  const cancel = useCallback(() => {
    cancelTokenRef.current.cancelled = true;
    safeSetState((prev) => ({ ...prev, phase: "cancelled" }));
  }, [safeSetState]);

  const reset = useCallback(() => {
    cancelTokenRef.current = { cancelled: false };
    safeSetState(() => INITIAL_STATE);
  }, [safeSetState]);

  const startUpload = useCallback(
    async (
      datasetKey: string,
      file: File
    ): Promise<{ jobId: string } | null> => {
      // Reset cancellation token for a fresh upload attempt.
      cancelTokenRef.current = { cancelled: false };
      const localToken = cancelTokenRef.current;

      const plan = computeUploadChunkPlan(file.size);
      if (plan.totalChunks === 0) {
        safeSetState(() => ({
          ...INITIAL_STATE,
          phase: "failed",
          error: "File is empty.",
        }));
        return null;
      }

      // 1) Reserve a job.
      safeSetState(() => ({
        ...INITIAL_STATE,
        phase: "starting",
        totalChunks: plan.totalChunks,
      }));

      let started: { jobId: string; uploadId: string };
      try {
        const result =
          await utils.client.solarRecDashboard.startDatasetUpload.mutate({
            datasetKey,
            fileName: file.name || `${datasetKey}.csv`,
            fileSize: file.size,
            totalChunks: plan.totalChunks,
          });
        started = { jobId: result.jobId, uploadId: result.uploadId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        safeSetState((prev) => ({ ...prev, phase: "failed", error: message }));
        return null;
      }

      if (localToken.cancelled) {
        safeSetState((prev) => ({ ...prev, phase: "cancelled" }));
        return null;
      }

      safeSetState((prev) => ({
        ...prev,
        phase: "uploading",
        jobId: started.jobId,
        uploadId: started.uploadId,
      }));

      // 2) Stream chunks in order. Each chunk: slice → base64 →
      // POST. On any failure we abort and mark the job failed.
      for (const chunk of plan.chunks) {
        if (localToken.cancelled) {
          safeSetState((prev) => ({ ...prev, phase: "cancelled" }));
          return null;
        }
        try {
          const slice: Blob = file.slice(chunk.byteStart, chunk.byteEnd);
          const chunkBase64 = await blobToBase64(slice);
          await utils.client.solarRecDashboard.uploadDatasetChunk.mutate({
            jobId: started.jobId,
            uploadId: started.uploadId,
            chunkIndex: chunk.chunkIndex,
            totalChunks: plan.totalChunks,
            chunkBase64,
          });
          safeSetState((prev) => ({
            ...prev,
            uploadedChunks: prev.uploadedChunks + 1,
          }));
        } catch (err) {
          const message =
            err instanceof Error ? err.message : describeChunkError(chunk, err);
          safeSetState((prev) => ({
            ...prev,
            phase: "failed",
            error: message,
          }));
          return null;
        }
      }

      // 3) Finalize.
      if (localToken.cancelled) {
        safeSetState((prev) => ({ ...prev, phase: "cancelled" }));
        return null;
      }
      safeSetState((prev) => ({ ...prev, phase: "finalizing" }));

      try {
        await utils.client.solarRecDashboard.finalizeDatasetUpload.mutate({
          jobId: started.jobId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        safeSetState((prev) => ({ ...prev, phase: "failed", error: message }));
        return null;
      }

      // The runner is now executing on the server. The dialog's
      // status poller takes over from here. We mark the controller
      // "done" — the *upload* is done; the *job* may still be
      // parsing/writing. Status poll surfaces that.
      safeSetState((prev) => ({ ...prev, phase: "done" }));
      return { jobId: started.jobId };
    },
    [safeSetState, utils.client]
  );

  return { state, startUpload, cancel, reset };
}

function describeChunkError(chunk: UploadChunkPlanItem, err: unknown): string {
  const detail =
    err && typeof err === "object" && "message" in err
      ? String((err as { message?: unknown }).message ?? "")
      : String(err);
  return `Chunk ${chunk.chunkIndex} failed: ${detail || "Unknown error"}`;
}
