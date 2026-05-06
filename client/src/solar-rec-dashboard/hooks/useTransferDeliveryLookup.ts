/**
 * Server-side transfer delivery lookup reader.
 *
 * Fetches the (trackingId → energyYear → deliveredQuantity) lookup
 * computed by the server from the active transferHistory batch, and
 * revives the wire format (nested plain objects) to the Map-of-Maps
 * the rest of the dashboard code expects.
 *
 * The server's own `inputVersionHash` is just the active batch ID —
 * rehydrating or invalidating happens automatically when a new
 * transferHistory upload lands (Phase 8.1.5 auto-sync).
 */

import { useMemo } from "react";
// Task 5.5 (2026-04-26): solarRecDashboard.* on the standalone Solar
// REC router. Alias keeps call sites unchanged.
import { solarRecTrpc as trpc } from "@/solar-rec/solarRecTrpc";
import type { TransferDeliveryLookup } from "../lib/transferHistoryDeliveries";

export type TransferDeliveryLookupState = {
  /**
   * Revived Map keyed by lowercased tracking ID →
   * inner Map keyed by energyYearStart (number) → quantity (number).
   * Null while the fetch is in flight, on error, or when the
   * feature flag is off.
   */
  lookup: TransferDeliveryLookup | null;
  /** Active transferHistory batch ID used to compute this lookup. */
  inputVersionHash: string | null;
  /** True once the first successful result has arrived. */
  isReady: boolean;
  /** True if the fetch hit a network or tRPC error. */
  isError: boolean;
};

function revive(
  byTrackingId: Record<string, Record<string, number>>
): TransferDeliveryLookup {
  const lookup: TransferDeliveryLookup = new Map();
  for (const [trackingId, yearMap] of Object.entries(byTrackingId)) {
    const inner = new Map<number, number>();
    for (const [yearKey, qty] of Object.entries(yearMap)) {
      const year = Number(yearKey);
      if (!Number.isFinite(year)) continue;
      inner.set(year, qty);
    }
    lookup.set(trackingId, inner);
  }
  return lookup;
}

/**
 * Fetch the transfer-based delivery lookup from the server.
 */
export function useTransferDeliveryLookup(
  enabled = true
): TransferDeliveryLookupState {
  const scopeQuery = trpc.solarRecDashboard.getScopeId.useQuery(undefined, {
    enabled,
    staleTime: Infinity,
    retry: 1,
  });
  const scopeId = scopeQuery.data?.scopeId ?? null;

  const lookupQuery = trpc.solarRecDashboard.getTransferDeliveryLookup.useQuery(
    { scopeId: scopeId ?? "" },
    {
      enabled: enabled && !!scopeId,
      staleTime: 60_000,
      retry: 1,
    }
  );

  const lookup = useMemo<TransferDeliveryLookup | null>(() => {
    const data = lookupQuery.data;
    if (!data) return null;
    return revive(data.byTrackingId);
  }, [lookupQuery.data]);

  return {
    lookup,
    inputVersionHash: lookupQuery.data?.inputVersionHash ?? null,
    isReady: lookup !== null,
    isError: lookupQuery.isError || scopeQuery.isError,
  };
}
