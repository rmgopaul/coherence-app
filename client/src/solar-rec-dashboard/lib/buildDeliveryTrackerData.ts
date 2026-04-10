/**
 * Pure function that builds the Delivery Tracker's derived state from
 * pre-merged schedule rows and transfer history rows.
 *
 * Extracted verbatim from the deliveryTrackerData useMemo in
 * SolarRecDashboard.tsx:10068-10216 during Phase 0 of the dashboard rebuild.
 *
 * Differences from the original memo:
 *   1. The caller is responsible for merging recDeliverySchedules and
 *      deliveryScheduleBase via mergeScheduleRows — this function takes a
 *      single `scheduleRows` input rather than reading datasets state.
 *   2. The `year.yearStart || year.yearEnd` null-skip at the original
 *      line 10144 is loosened to `!year.yearStart` only. Combined with
 *      the scheduleBScanner fix that now emits year dates, this is
 *      belt-and-suspenders against any future partial-date row.
 *
 * Everything else — contract aggregation, direction detection, energy-year
 * fallback matching, diagnostics — is a line-for-line copy.
 */

import {
  buildDeliveryYearLabel,
  clean,
  parseDate,
  parseNumber,
  toPercentValue,
} from "./parsers";
import { UTILITY_PATTERNS } from "./constants";
import type { CsvRow } from "./mergeScheduleRows";

export type DeliveryTrackerRow = {
  systemName: string;
  unitId: string;
  contractId: string;
  yearLabel: string;
  yearStart: Date | null;
  yearEnd: Date | null;
  obligated: number;
  delivered: number;
  gap: number;
};

export type DeliveryTrackerContractSummary = {
  contractId: string;
  systems: number;
  totalObligated: number;
  totalDelivered: number;
  totalGap: number;
  deliveryPercent: number | null;
};

export type DeliveryTrackerData = {
  rows: DeliveryTrackerRow[];
  contracts: DeliveryTrackerContractSummary[];
  totalTransfers: number;
  unmatchedTransfers: number;
  scheduleIdSample: string[];
  transferIdSample: string[];
  scheduleCount: number;
};

export const EMPTY_DELIVERY_TRACKER_DATA: DeliveryTrackerData = Object.freeze({
  rows: [],
  contracts: [],
  totalTransfers: 0,
  unmatchedTransfers: 0,
  scheduleIdSample: [],
  transferIdSample: [],
  scheduleCount: 0,
}) as DeliveryTrackerData;

type YearSlot = {
  yearLabel: string;
  yearStart: Date | null;
  yearEnd: Date | null;
  obligated: number;
  delivered: number;
};

type SystemSchedule = {
  systemName: string;
  unitId: string;
  contractId: string;
  years: YearSlot[];
};

export function buildDeliveryTrackerData(input: {
  scheduleRows: CsvRow[];
  transferRows: CsvRow[];
}): DeliveryTrackerData {
  const { scheduleRows, transferRows } = input;

  // Build schedule: system → year → { obligated, startDate, endDate }
  const systemSchedules = new Map<string, SystemSchedule>();

  for (const row of scheduleRows) {
    const unitId = clean(row.tracking_system_ref_id);
    if (!unitId) continue;
    const systemName = clean(row.system_name) || unitId;
    const contractId = clean(row.utility_contract_number) || "Unassigned";
    const years: YearSlot[] = [];

    for (let y = 1; y <= 15; y++) {
      const required = parseNumber(row[`year${y}_quantity_required`]) ?? 0;
      const startDate = parseDate(row[`year${y}_start_date`]);
      const endDate = parseDate(row[`year${y}_end_date`]);
      if (required === 0 && !startDate) continue;
      const yearLabel = buildDeliveryYearLabel(
        startDate,
        endDate,
        row[`year${y}_start_date`] ?? "",
        row[`year${y}_end_date`] ?? ""
      );
      years.push({
        yearLabel,
        yearStart: startDate,
        yearEnd: endDate,
        obligated: required,
        delivered: 0,
      });
    }

    if (years.length > 0) {
      systemSchedules.set(unitId.toLowerCase(), { systemName, unitId, contractId, years });
    }
  }

  // Process transfers: allocate to energy years
  let totalTransfers = 0;
  let unmatchedTransfers = 0;

  for (const row of transferRows) {
    const unitId = clean(row["Unit ID"]);
    if (!unitId) continue;
    const qty = parseNumber(row.Quantity) ?? 0;
    if (qty === 0) continue;

    const transferor = (clean(row.Transferor) ?? "").toLowerCase();
    const transferee = (clean(row.Transferee) ?? "").toLowerCase();

    // Determine direction
    let direction = 0;
    const isFromCS = transferor.includes("carbon solutions");
    const isToCS = transferee.includes("carbon solutions");
    const transfereeIsUtility = UTILITY_PATTERNS.some((u) => transferee.includes(u));
    const transferorIsUtility = UTILITY_PATTERNS.some((u) => transferor.includes(u));

    if (isFromCS && transfereeIsUtility) direction = 1; // delivery
    else if (transferorIsUtility && isToCS) direction = -1; // return/subtract
    else continue; // Skip non-utility transfers

    totalTransfers++;

    // Parse Transfer Completion Date to determine energy year
    const completionDateRaw = clean(row["Transfer Completion Date"]);
    const completionDate = completionDateRaw ? parseDate(completionDateRaw) : null;
    if (!completionDate) continue;

    // Find system schedule
    const schedule = systemSchedules.get(unitId.toLowerCase());
    if (!schedule) {
      unmatchedTransfers++;
      continue;
    }

    // Find which year slot this transfer falls into
    let matched = false;
    for (const year of schedule.years) {
      // Bug 2 fix: loosen the original `!yearStart || !yearEnd` skip to
      // just `!yearStart`. End date is optional now that scheduleBScanner
      // always emits a full (start, end) pair; the fallback matcher below
      // only needs yearStart anyway.
      if (!year.yearStart) continue;
      if (year.yearEnd) {
        // Energy year: start <= completionDate <= end
        if (completionDate >= year.yearStart && completionDate <= year.yearEnd) {
          year.delivered += qty * direction;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      // Try to match by energy year boundaries (June 1 – May 31)
      const completionMonth = completionDate.getMonth(); // 0-indexed
      const completionYear = completionDate.getFullYear();
      const eyStartYear = completionMonth >= 5 ? completionYear : completionYear - 1; // June=5
      for (const year of schedule.years) {
        if (!year.yearStart) continue;
        if (year.yearStart.getFullYear() === eyStartYear) {
          year.delivered += qty * direction;
          matched = true;
          break;
        }
      }
      if (!matched) unmatchedTransfers++;
    }
  }

  // Build output rows
  const rows: DeliveryTrackerRow[] = [];
  const contractAgg = new Map<string, DeliveryTrackerContractSummary>();

  systemSchedules.forEach((schedule) => {
    for (const year of schedule.years) {
      const gap = year.obligated - year.delivered;
      rows.push({
        systemName: schedule.systemName,
        unitId: schedule.unitId,
        contractId: schedule.contractId,
        yearLabel: year.yearLabel,
        yearStart: year.yearStart,
        yearEnd: year.yearEnd,
        obligated: year.obligated,
        delivered: year.delivered,
        gap,
      });

      // Contract aggregation
      const c = contractAgg.get(schedule.contractId) ?? {
        contractId: schedule.contractId,
        systems: 0,
        totalObligated: 0,
        totalDelivered: 0,
        totalGap: 0,
        deliveryPercent: null,
      };
      c.totalObligated += year.obligated;
      c.totalDelivered += year.delivered;
      c.totalGap += gap;
      contractAgg.set(schedule.contractId, c);
    }
    // Count unique systems per contract
    const c = contractAgg.get(schedule.contractId);
    if (c) c.systems++;
  });

  const contracts = Array.from(contractAgg.values())
    .map((c) => ({ ...c, deliveryPercent: toPercentValue(c.totalDelivered, c.totalObligated) }))
    .sort((a, b) => a.contractId.localeCompare(b.contractId, undefined, { numeric: true }));

  // Diagnostics: sample IDs from each side for debugging
  const scheduleIdSample = Array.from(systemSchedules.keys()).slice(0, 5);
  const transferIdSample = Array.from(
    new Set(
      transferRows
        .slice(0, 100)
        .map((r) => clean(r["Unit ID"])?.toLowerCase())
        .filter(Boolean)
    )
  ).slice(0, 5);

  return {
    rows,
    contracts,
    totalTransfers,
    unmatchedTransfers,
    scheduleIdSample,
    transferIdSample,
    scheduleCount: systemSchedules.size,
  };
}
