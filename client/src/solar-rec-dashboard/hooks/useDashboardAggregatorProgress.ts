/**
 * Client hook for the dashboard aggregator-progress channel
 * (Phase B2 — 2026-05-12).
 *
 * Pairs with `server/services/solar/dashboardAggregatorProgress.ts`
 * + the `solarRecDashboard.getDashboardAggregatorProgress` tRPC
 * query.
 *
 * Usage:
 *   const { progress, isPolling } = useDashboardAggregatorProgress(
 *     "contractVintage",
 *     { enabled: contractVintageQuery.isLoading }
 *   );
 *   {progress && <AggregatorProgressOverlay progress={progress} />}
 *
 * The hook polls every 500 ms while `enabled` is true. When the
 * parent's main aggregator query settles, the hook stops polling
 * and the cache TTL takes care of the rest.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";

const POLL_INTERVAL_MS = 500;

export type AggregatorProgressSnapshot = {
  scopeId: string;
  aggregatorKey: string;
  stage: "loading" | "computing" | "writing";
  stageLabel: string;
  fractionComplete: number;
  current: number | null;
  total: number | null;
  unitLabel: string | null;
  state: "running" | "done" | "failed";
  errorMessage: string | null;
  startedAt: number;
  updatedAt: number;
};

export function useDashboardAggregatorProgress(
  aggregatorKey: string,
  options: { enabled: boolean }
): {
  progress: AggregatorProgressSnapshot | null;
  isPolling: boolean;
} {
  const { enabled } = options;
  const query =
    solarRecTrpc.solarRecDashboard.getDashboardAggregatorProgress.useQuery(
      { aggregatorKey },
      {
        enabled,
        refetchInterval: enabled ? POLL_INTERVAL_MS : false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: 0,
      }
    );

  // Once the main aggregator query settles, the server entry will
  // either disappear (no progress in flight) or briefly show
  // state="done". Either way the parent will hide the overlay; we
  // just need to make sure we don't render stale data from a
  // previous cycle. Track the last non-null snapshot so transient
  // null responses between recomputes don't flash the bar away.
  const lastSnapshotRef = useRef<AggregatorProgressSnapshot | null>(null);
  const [staleAfterDisable, setStaleAfterDisable] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setStaleAfterDisable(true);
      lastSnapshotRef.current = null;
    } else {
      setStaleAfterDisable(false);
    }
  }, [enabled]);

  const progress = useMemo<AggregatorProgressSnapshot | null>(() => {
    if (!enabled || staleAfterDisable) return null;
    const raw = query.data?.progress ?? null;
    if (raw) lastSnapshotRef.current = raw;
    return raw ?? lastSnapshotRef.current;
  }, [enabled, staleAfterDisable, query.data?.progress]);

  return {
    progress,
    isPolling: enabled,
  };
}
