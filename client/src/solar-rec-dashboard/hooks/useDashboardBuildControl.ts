import { useCallback, useEffect, useState } from "react";
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
import { isTerminalDashboardBuildStatus } from "@/solar-rec-dashboard/lib/dashboardBuildStatus";

export interface UseDashboardBuildControlOptions {
  onSucceeded?: () => void | Promise<void>;
  failureMessage?: string;
  startFailureMessage?: string;
}

/**
 * Real-time per-step build progress, mirrored from the server's
 * `DashboardBuildProgress` shape (see
 * `server/services/solar/dashboardBuildJobs.ts:64-70`).
 *
 * The runner writes this row on every step boundary
 * (`Starting <stepName>` at start, `Build complete` at end), so a
 * 2 s poll gives the user a smooth per-step progress bar instead
 * of the flat "Building…" placeholder.
 */
export interface DashboardBuildProgressSnapshot {
  currentStep: number;
  totalSteps: number;
  /** Server-computed percent (0-100). Caller should clamp before render. */
  percent: number;
  /** Stage label, e.g. "Starting ownershipFacts" / "Build complete". */
  message: string | null;
  /** Name of the fact table currently being built. null between steps + on final. */
  factTable: string | null;
}

export interface DashboardBuildControl {
  buildErrorMessage: string | null;
  buildStatus: string | null;
  isBuildRunning: boolean;
  /**
   * 2026-05-13 — real per-step progress mirrored from the runner's
   * DB-backed status row. Null when no build is in flight or the
   * server hasn't reported a progress row yet. Replaces the flat
   * "Building…" placeholder that the rebuild buttons used to show.
   */
  buildProgress: DashboardBuildProgressSnapshot | null;
  startBuild: () => Promise<void>;
}

export function useDashboardBuildControl(
  options: UseDashboardBuildControlOptions = {},
): DashboardBuildControl {
  const {
    onSucceeded,
    failureMessage = "Dashboard build did not complete.",
    startFailureMessage = "Unable to start dashboard build.",
  } = options;
  const [activeBuildId, setActiveBuildId] = useState<string | null>(null);
  const [processedBuildId, setProcessedBuildId] = useState<string | null>(null);
  const [buildErrorMessage, setBuildErrorMessage] = useState<string | null>(
    null,
  );

  const startDashboardBuild =
    solarRecTrpc.solarRecDashboard.startDashboardBuild.useMutation();
  const buildStatusQuery =
    solarRecTrpc.solarRecDashboard.getDashboardBuildStatus.useQuery(
      { buildId: activeBuildId ?? "__none__" },
      {
        enabled: activeBuildId !== null,
        refetchInterval: (query) => {
          const status = query.state.data?.status;
          if (isTerminalDashboardBuildStatus(status)) return false;
          return 2_000;
        },
        retry: false,
        staleTime: 0,
      },
    );

  useEffect(() => {
    if (!activeBuildId || processedBuildId === activeBuildId) return;
    const status = buildStatusQuery.data?.status;
    if (status === "succeeded") {
      setProcessedBuildId(activeBuildId);
      setBuildErrorMessage(null);
      try {
        const maybePromise = onSucceeded?.();
        if (maybePromise) {
          void maybePromise.catch((error: unknown) => {
            setBuildErrorMessage(
              error instanceof Error
                ? error.message
                : "Dashboard build completed, but refresh failed.",
            );
          });
        }
      } catch (error) {
        setBuildErrorMessage(
          error instanceof Error
            ? error.message
            : "Dashboard build completed, but refresh failed.",
        );
      }
    } else if (status === "failed" || status === "notFound") {
      setProcessedBuildId(activeBuildId);
      setBuildErrorMessage(
        buildStatusQuery.data?.errorMessage ?? failureMessage,
      );
    }
  }, [
    activeBuildId,
    buildStatusQuery.data?.errorMessage,
    buildStatusQuery.data?.status,
    failureMessage,
    onSucceeded,
    processedBuildId,
  ]);

  const startBuild = useCallback(async () => {
    try {
      setBuildErrorMessage(null);
      const result = await startDashboardBuild.mutateAsync();
      setActiveBuildId(result.buildId);
      setProcessedBuildId(null);
    } catch (error) {
      setBuildErrorMessage(
        error instanceof Error ? error.message : startFailureMessage,
      );
    }
  }, [startDashboardBuild, startFailureMessage]);

  const buildStatus = buildStatusQuery.data?.status ?? null;
  const isBuildRunning =
    startDashboardBuild.isPending ||
    buildStatus === "queued" ||
    buildStatus === "running";

  // 2026-05-13 — mirror the server's per-step progress row. The
  // server writes this BEFORE each step starts ("Starting X") and
  // after the final step succeeds ("Build complete" at 100%). Null
  // when the build is queued but hasn't entered the loop yet, OR
  // when the row's `progressJson` couldn't be parsed (the server-
  // side `parseProgress` returns null in that case).
  const buildProgress = buildStatusQuery.data?.progress ?? null;

  return {
    buildErrorMessage,
    buildStatus,
    isBuildRunning,
    buildProgress,
    startBuild,
  };
}
