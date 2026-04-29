/**
 * System-level aggregation helpers. Contract value resolution and
 * the tracking-ID-keyed map builders shared between the Performance
 * Ratio and Forecast tabs.
 */

import type { SystemRecord } from "@/solar-rec-dashboard/state/types";
import { firstNonNull } from "./misc";

export {
  buildAnnualProductionByTrackingId,
  buildGenerationBaselineByTrackingId,
  buildGeneratorDateOnlineByTrackingId,
} from "@shared/solarRecPerformanceRatio";

export function resolveContractValueAmount(system: SystemRecord): number {
  return firstNonNull(system.totalContractAmount, system.contractedValue) ?? 0;
}

export function resolveValueGapAmount(system: SystemRecord): number {
  return resolveContractValueAmount(system) - (system.deliveredValue ?? 0);
}
