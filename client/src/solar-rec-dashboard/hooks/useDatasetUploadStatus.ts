/**
 * Phase 2 of the IndexedDB-removal refactor — status poller.
 *
 * Watches a single dataset-upload job by polling
 * `solarRecDashboard.getDatasetUploadStatus` every 2s until the
 * status reaches a terminal value (`done` or `failed`). React
 * Query owns the poll interval; this hook just configures the
 * cadence + the stop-on-terminal predicate.
 *
 * Used by `<UploadProgressDialog>` after the
 * `useDatasetUploadController` hook hands off a jobId.
 */
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
import { isTerminalUploadStatus } from "@shared/datasetUpload.helpers";

export const DATASET_UPLOAD_POLL_INTERVAL_MS = 2_000;

export function useDatasetUploadStatus(jobId: string | null) {
  return solarRecTrpc.solarRecDashboard.getDatasetUploadStatus.useQuery(
    // The query ignores undefined args once `enabled` is false, but
    // tRPC v11's input must be defined when enabled is true. Pass a
    // non-empty string when jobId is null so the type narrowing
    // below holds; the `enabled` flag prevents the proc from
    // actually firing.
    { jobId: jobId ?? "__none__" },
    {
      enabled: jobId !== null && jobId.length > 0,
      // Halt polling once the job reaches a terminal status —
      // returning `false` from `refetchInterval` stops the timer.
      refetchInterval: (query) => {
        const status = query.state.data?.job?.status;
        if (status && isTerminalUploadStatus(status)) return false;
        return DATASET_UPLOAD_POLL_INTERVAL_MS;
      },
      // Fast-poll while the user is looking at the dialog; slow
      // down only when the tab is backgrounded.
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
      // Don't retry on errors — a transient blip will be picked up
      // on the next 2s tick. Retrying would just stack failed
      // requests and confuse the dialog.
      retry: false,
      // Override the global staleTime so the query always re-runs
      // on dialog mount (otherwise the React Query cache might
      // serve a stale "queued" snapshot from a prior session).
      staleTime: 0,
    }
  );
}
