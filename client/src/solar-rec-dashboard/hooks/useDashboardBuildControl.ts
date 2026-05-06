import { useCallback, useEffect, useState } from "react";
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
import { isTerminalDashboardBuildStatus } from "@/solar-rec-dashboard/lib/dashboardBuildStatus";

export interface UseDashboardBuildControlOptions {
  onSucceeded?: () => void | Promise<void>;
  failureMessage?: string;
  startFailureMessage?: string;
}

export interface DashboardBuildControl {
  buildErrorMessage: string | null;
  buildStatus: string | null;
  isBuildRunning: boolean;
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

  return {
    buildErrorMessage,
    buildStatus,
    isBuildRunning,
    startBuild,
  };
}
