/**
 * System-level aggregation helpers. Contract value resolution and
 * the tracking-ID-keyed map builders shared between the Performance
 * Ratio and Forecast tabs.
 */

import { clean } from "@/lib/helpers";
import type {
  AnnualProductionProfile,
  CsvRow,
  GenerationBaseline,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";
import {
  GENERATION_BASELINE_DATE_HEADERS,
  GENERATION_BASELINE_VALUE_HEADERS,
  MONTH_HEADERS,
} from "@/solar-rec-dashboard/lib/constants";
import {
  parseDate,
  parseDateOnlineAsMidMonth,
  parseEnergyToWh,
  parseNumber,
} from "./parsing";
import { resolveLastMeterReadRawValue } from "./csvIdentity";
import { firstNonNull } from "./misc";

export function resolveContractValueAmount(system: SystemRecord): number {
  return firstNonNull(system.totalContractAmount, system.contractedValue) ?? 0;
}

export function resolveValueGapAmount(system: SystemRecord): number {
  return resolveContractValueAmount(system) - (system.deliveredValue ?? 0);
}

/**
 * Build a Map<trackingSystemRefId, AnnualProductionProfile> from the
 * annual-production-estimates CSV.  Pure function — same inputs always
 * yield the same output.  Used by both the Performance Ratio tab and the
 * Forecast tab; each tab owns its own useMemo and calls this independently.
 */
export function buildAnnualProductionByTrackingId(
  rows: CsvRow[],
): Map<string, AnnualProductionProfile> {
  const mapping = new Map<string, AnnualProductionProfile>();

  rows.forEach((row) => {
    const trackingSystemRefId = clean(row["Unit ID"]) || clean(row.unit_id);
    if (!trackingSystemRefId) return;

    const monthlyKwh = MONTH_HEADERS.map(
      (month) => parseNumber(row[month] ?? row[month.toLowerCase()]) ?? 0,
    );
    const current = mapping.get(trackingSystemRefId);
    if (!current) {
      mapping.set(trackingSystemRefId, {
        trackingSystemRefId,
        facilityName: clean(row.Facility) || clean(row["Facility Name"]),
        monthlyKwh,
      });
      return;
    }

    const mergedMonthly = current.monthlyKwh.map((value, index) => {
      const candidate = monthlyKwh[index] ?? 0;
      return candidate > 0 ? candidate : value;
    });
    mapping.set(trackingSystemRefId, {
      trackingSystemRefId,
      facilityName:
        current.facilityName ||
        clean(row.Facility) ||
        clean(row["Facility Name"]),
      monthlyKwh: mergedMonthly,
    });
  });

  return mapping;
}

/**
 * Build a Map<trackingSystemRefId, GenerationBaseline> from generation-entry
 * and account-solar-generation CSVs.  "Generation Entry" takes priority over
 * "Account Solar Generation" when both have the same date, and newer dates
 * always win.  Pure function.
 */
export function buildGenerationBaselineByTrackingId(
  generationEntryRows: CsvRow[],
  accountSolarGenerationRows: CsvRow[],
): Map<string, GenerationBaseline> {
  const mapping = new Map<string, GenerationBaseline>();

  const updateBaseline = (
    trackingSystemRefId: string,
    candidate: GenerationBaseline,
  ) => {
    const existing = mapping.get(trackingSystemRefId);
    if (!existing) {
      mapping.set(trackingSystemRefId, candidate);
      return;
    }

    const existingTime = existing.date?.getTime() ?? Number.NEGATIVE_INFINITY;
    const candidateTime = candidate.date?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (candidateTime > existingTime) {
      mapping.set(trackingSystemRefId, candidate);
      return;
    }
    if (candidateTime === existingTime) {
      const existingRank = existing.source === "Generation Entry" ? 2 : 1;
      const candidateRank = candidate.source === "Generation Entry" ? 2 : 1;
      if (candidateRank > existingRank) {
        mapping.set(trackingSystemRefId, candidate);
      }
    }
  };

  generationEntryRows.forEach((row) => {
    const trackingSystemRefId = clean(row["Unit ID"]);
    if (!trackingSystemRefId) return;

    let valueWh: number | null = null;
    for (const header of GENERATION_BASELINE_VALUE_HEADERS) {
      valueWh = parseEnergyToWh(row[header], header, "kwh");
      if (valueWh !== null) break;
    }
    if (valueWh === null) return;

    let date: Date | null = null;
    for (const header of GENERATION_BASELINE_DATE_HEADERS) {
      date = parseDate(row[header]);
      if (date) break;
    }

    updateBaseline(trackingSystemRefId, {
      valueWh,
      date,
      source: "Generation Entry",
    });
  });

  accountSolarGenerationRows.forEach((row) => {
    const trackingSystemRefId = clean(row["GATS Gen ID"]);
    if (!trackingSystemRefId) return;

    const valueWh = parseEnergyToWh(
      resolveLastMeterReadRawValue(row),
      "Last Meter Read (kWh)",
      "kwh",
    );
    if (valueWh === null) return;

    const date =
      parseDate(row["Last Meter Read Date"]) ??
      parseDate(row["Month of Generation"]);
    updateBaseline(trackingSystemRefId, {
      valueWh,
      date,
      source: "Account Solar Generation",
    });
  });

  return mapping;
}

/**
 * Build a Map<trackingSystemRefId, Date> from the generator-details CSV,
 * using the Date Online column snapped to the 15th of the given month.
 * Performance Ratio uses this as a fallback baseline when no generation
 * reading exists.
 */
export function buildGeneratorDateOnlineByTrackingId(
  rows: CsvRow[],
): Map<string, Date> {
  const mapping = new Map<string, Date>();

  rows.forEach((row) => {
    const trackingSystemRefId =
      clean(row["GATS Unit ID"]) ||
      clean(row.gats_unit_id) ||
      clean(row["Unit ID"]);
    if (!trackingSystemRefId) return;
    const dateOnline = parseDateOnlineAsMidMonth(
      row["Date Online"] ??
        row["Date online"] ??
        row.date_online ??
        row.date_online_month_year,
    );
    if (!dateOnline) return;

    const existing = mapping.get(trackingSystemRefId);
    if (!existing || dateOnline < existing) {
      mapping.set(trackingSystemRefId, dateOnline);
    }
  });

  return mapping;
}
