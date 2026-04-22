/**
 * Server-side system snapshot reader.
 *
 * Fetches the server-computed SystemRecord[] snapshot via tRPC and
 * handles the async "building" state with 3-second polling. When
 * the server reports `building: true` the returned `systems` is
 * null and `isBuilding` is true; consumers should treat that
 * exactly like "data not loaded yet".
 *
 * Date fields on the wire are ISO strings (tRPC JSON serialization)
 * and get revived to Date objects here so downstream code can treat
 * them as SystemRecord's declared `Date | null` type.
 */

import { useEffect, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import type { SystemRecord } from "../state/types";

type SnapshotRow = Omit<
  SystemRecord,
  "latestReportingDate" | "zillowSoldDate" | "contractedDate" | "part2VerificationDate"
> & {
  latestReportingDate: string | null;
  zillowSoldDate: string | null;
  contractedDate: string | null;
  part2VerificationDate: string | null;
};

const POLL_INTERVAL_MS = 5000;

function reviveDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function reviveSystem(row: SnapshotRow): SystemRecord {
  return {
    ...(row as unknown as SystemRecord),
    latestReportingDate: reviveDate(row.latestReportingDate),
    zillowSoldDate: reviveDate(row.zillowSoldDate),
    contractedDate: reviveDate(row.contractedDate),
    part2VerificationDate: reviveDate(row.part2VerificationDate),
  };
}

export type SystemSnapshotState = {
  /**
   * Server-computed SystemRecord[] if available AND fully built.
   * Null during the first compute (building=true), on error, or
   * when the feature flag is off.
   */
  systems: SystemRecord[] | null;
  /** True once the server has returned a non-building result. */
  isReady: boolean;
  /** True while the server is computing (first fetch for this hash). */
  isBuilding: boolean;
  /** True if the snapshot fetch hit a network/tRPC error. */
  isError: boolean;
  /** Server-reported hash of the inputs used to compute the snapshot. */
  inputVersionHash: string | null;
};

/**
 * Fetch the server-computed system snapshot for the Solar REC
 * dashboard.
 */
export function useSystemSnapshot(): SystemSnapshotState {
  // Resolve scopeId first so we can key the snapshot query.
  const scopeQuery = trpc.solarRecDashboard.getScopeId.useQuery(undefined, {
    staleTime: Infinity,
    retry: 1,
  });
  const scopeId = scopeQuery.data?.scopeId ?? null;

  const snapshotQuery = trpc.solarRecDashboard.getSystemSnapshot.useQuery(
    { scopeId: scopeId ?? "" },
    {
      enabled: !!scopeId,
      // While the server reports building=true, poll every 3s so we
      // flip to the real result as soon as it's cached server-side.
      refetchInterval: (query) => {
        const data = query.state.data;
        return data && data.building ? POLL_INTERVAL_MS : false;
      },
      // Don't retry aggressively on transient errors — one retry is
      // enough, the 3s poll will pick up again soon anyway.
      retry: 1,
    }
  );

  const readySystems = useMemo<SystemRecord[] | null>(() => {
    const data = snapshotQuery.data;
    if (!data) return null;
    if (data.building) return null;
    if (!Array.isArray(data.systems)) return null;
    return (data.systems as SnapshotRow[]).map(reviveSystem);
  }, [snapshotQuery.data]);

  const lastReadySystemsRef = useRef<SystemRecord[] | null>(null);
  useEffect(() => {
    if (readySystems !== null) {
      lastReadySystemsRef.current = readySystems;
    }
  }, [readySystems]);

  const systems = useMemo<SystemRecord[] | null>(() => {
    if (readySystems !== null) {
      return readySystems;
    }
    if (snapshotQuery.data?.building === true) {
      return lastReadySystemsRef.current;
    }
    return null;
  }, [readySystems, snapshotQuery.data?.building]);

  return {
    systems,
    isReady: systems !== null,
    isBuilding: snapshotQuery.data?.building === true,
    isError: snapshotQuery.isError || scopeQuery.isError,
    inputVersionHash: snapshotQuery.data?.inputVersionHash ?? null,
  };
}
