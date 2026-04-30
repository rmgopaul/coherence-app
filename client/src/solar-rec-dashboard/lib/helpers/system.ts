/**
 * System-level aggregation helpers. Contract value resolution stays
 * client-local (depends on the client's `SystemRecord`); the
 * tracking-ID-keyed map builders re-export from
 * `@shared/solarRecPerformanceRatio` so the server aggregator and
 * this tab share one implementation.
 *
 * 2026-04-29 — PR D follow-up to PR #271 (Salvage A): the three
 * `build*ByTrackingId` bodies were byte-identical to their shared
 * counterparts after PR A's hoist; this file now re-exports them
 * directly. The function-level cast on
 * `buildGenerationBaselineByTrackingId` re-types the return Map's
 * value as the client's `GenerationBaseline` (which has `valueWh:
 * number | null`) — the shared type is stricter (`valueWh: number`)
 * and the function never produces null at runtime, so the cast is
 * sound. Map<K, V> is invariant in V, which is why a pure re-export
 * would not type-check at the call sites.
 */

import type {
  AnnualProductionProfile,
  CsvRow,
  GenerationBaseline,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";
import {
  buildAnnualProductionByTrackingId as sharedBuildAnnualProductionByTrackingId,
  buildGenerationBaselineByTrackingId as sharedBuildGenerationBaselineByTrackingId,
  buildGeneratorDateOnlineByTrackingId as sharedBuildGeneratorDateOnlineByTrackingId,
} from "@shared/solarRecPerformanceRatio";
import { firstNonNull } from "./misc";

export function resolveContractValueAmount(
  system: Pick<SystemRecord, "totalContractAmount" | "contractedValue">,
): number {
  return firstNonNull(system.totalContractAmount, system.contractedValue) ?? 0;
}

export function resolveValueGapAmount(system: SystemRecord): number {
  return resolveContractValueAmount(system) - (system.deliveredValue ?? 0);
}

/**
 * Build a Map<trackingSystemRefId, AnnualProductionProfile> from the
 * annual-production-estimates CSV. The shared and client
 * `AnnualProductionProfile` shapes are identical, so this is a pure
 * re-export.
 */
export const buildAnnualProductionByTrackingId: (
  rows: CsvRow[]
) => Map<string, AnnualProductionProfile> =
  sharedBuildAnnualProductionByTrackingId;

/**
 * Build a Map<trackingSystemRefId, GenerationBaseline> from
 * generation-entry and account-solar-generation CSVs. "Generation
 * Entry" takes priority over "Account Solar Generation" when both have
 * the same date, and newer dates always win.
 *
 * Cast widens the shared `valueWh: number` return type to the client's
 * `valueWh: number | null` — the function never produces null at
 * runtime (early-bails on null parse), but `Map<K, V>` is invariant in
 * V so a direct re-export with the client return type would not
 * type-check at call sites that store the result into a
 * `Map<string, ClientGenerationBaseline>`.
 */
export const buildGenerationBaselineByTrackingId = sharedBuildGenerationBaselineByTrackingId as (
  generationEntryRows: CsvRow[],
  accountSolarGenerationRows: CsvRow[]
) => Map<string, GenerationBaseline>;

/**
 * Build a Map<trackingSystemRefId, Date> from the generator-details
 * CSV using the Date Online column snapped to the 15th of the given
 * month. Performance Ratio uses this as a fallback baseline when no
 * generation reading exists.
 */
export const buildGeneratorDateOnlineByTrackingId: (
  rows: CsvRow[]
) => Map<string, Date> = sharedBuildGeneratorDateOnlineByTrackingId;
