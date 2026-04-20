/**
 * Pure function that builds the Delivery Tracker's derived state from
 * Schedule B obligation rows and GATS transfer history rows.
 *
 * Phase 1a: the caller passes ONLY `deliveryScheduleBase.rows` as
 * `scheduleRows`. There is no merge with `recDeliverySchedules` —
 * Schedule B is the single source of truth for obligations; transfer
 * history is the single source of truth for deliveries.
 *
 * Every transfer is classified into one of four outcomes:
 *   - matched: credited to a specific year_slot.delivered
 *   - `transfersMissingObligation`: system has no Schedule B at all
 *   - `transfersPreDeliverySchedule`: system has a Schedule B, transfer
 *      predates its earliest year (NOT counted in `unmatchedTransfers`)
 *   - `transfersUnmatchedByYear`: system has a Schedule B but the transfer
 *      date falls outside every year window and the energy-year fallback
 *      also missed — usually a bad PDF parse or a post-contract transfer
 *
 * `unmatchedTransfers` (the summary-card counter) = `transfersMissingObligation`
 * count + `transfersUnmatchedByYear` count. Pre-delivery is intentionally
 * excluded so the counter reflects only truly anomalous matches.
 *
 * The function also emits `schedulesWithYearsOutsideBounds` as a parse-
 * quality diagnostic: scraped Schedule Bs with at least one year outside
 * [2019, 2042].
 */

import {
  buildDeliveryYearLabel,
  clean,
  parseDate,
  parseNumber,
  toPercentValue,
} from "./parsers";
import { UTILITY_PATTERNS } from "./constants";
import type { CsvRow } from "../state/types";

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

/**
 * One row per tracking ID in a transfer-classification bucket. Three
 * DeliveryTrackerData fields share this shape —
 * `transfersMissingObligation`, `transfersUnmatchedByYear`,
 * `transfersPreDeliverySchedule`.
 */
export type TransferBucketEntry = {
  trackingId: string;
  transferCount: number;
};

/** A single scraped year whose start or end fell outside [2019, 2042]. */
export type OutOfBoundsYear = {
  yearLabel: string;
  startYear: number | null;
  endYear: number | null;
};

/**
 * A scraped Schedule B flagged because at least one of its year
 * boundaries falls outside the plausible range. Almost always a bad
 * PDF parse; re-scrape the source.
 */
export type FlaggedSchedule = {
  trackingId: string;
  systemName: string;
  outOfBoundsYears: OutOfBoundsYear[];
};

/**
 * String-union of every transfer-classification bucket the export
 * (and UI) can emit. Use the `BUCKET` constant below rather than the
 * bare string literal so typos are caught by the compiler.
 */
export type TransferBucket =
  | "missing_schedule_b"
  | "pre_delivery_schedule"
  | "year_mismatch";

/**
 * Canonical names for each transfer-classification bucket. Referenced
 * by the CSV export, the card description, and any consumer that has
 * to emit / compare the bucket name.
 */
export const BUCKET = {
  missingScheduleB: "missing_schedule_b",
  preDeliverySchedule: "pre_delivery_schedule",
  yearMismatch: "year_mismatch",
} as const satisfies Record<string, TransferBucket>;

export type DeliveryTrackerData = {
  rows: DeliveryTrackerRow[];
  contracts: DeliveryTrackerContractSummary[];
  totalTransfers: number;
  /**
   * Transfers that couldn't be credited to a year slot AND are not
   * classified as pre-delivery. Equals `transfersMissingObligation`
   * transfer count + `transfersUnmatchedByYear` transfer count.
   */
  unmatchedTransfers: number;
  scheduleIdSample: string[];
  transferIdSample: string[];
  scheduleCount: number;
  /**
   * Distinct tracking IDs that have at least one transfer in GATS
   * Transfer History but NO matching Schedule B obligation. These are
   * systems the user still needs to scrape Schedule B PDFs for.
   * Populated only when transfer history exists.
   */
  transfersMissingObligation: TransferBucketEntry[];
  /**
   * Distinct tracking IDs where a Schedule B exists but the transfer's
   * completion date fell outside every scraped year slot (including the
   * energy-year fallback) AND was not before the earliest year start.
   * Residual anomaly bucket — usually a malformed PDF parse or a
   * post-contract transfer.
   */
  transfersUnmatchedByYear: TransferBucketEntry[];
  /**
   * Distinct tracking IDs where a Schedule B exists and the transfer
   * completion date is BEFORE the earliest scraped year_start for that
   * system. These are real transfers that predate the delivery-schedule
   * window (system generating RECs before the contract started) and are
   * NOT counted toward `unmatchedTransfers`.
   */
  transfersPreDeliverySchedule: TransferBucketEntry[];
  /**
   * Scraped Schedule Bs with at least one year boundary outside the
   * plausible [2019, 2042] range. Surfaced so bad parses can be found
   * and re-scraped.
   */
  schedulesWithYearsOutsideBounds: FlaggedSchedule[];
};

export const EMPTY_DELIVERY_TRACKER_DATA: DeliveryTrackerData = Object.freeze({
  rows: [],
  contracts: [],
  totalTransfers: 0,
  unmatchedTransfers: 0,
  scheduleIdSample: [],
  transferIdSample: [],
  scheduleCount: 0,
  transfersMissingObligation: [],
  transfersUnmatchedByYear: [],
  transfersPreDeliverySchedule: [],
  schedulesWithYearsOutsideBounds: [],
}) as DeliveryTrackerData;

// Plausible Schedule B delivery-year range. Anything outside this is
// almost certainly a bad PDF scrape (wrong year parsed, column offset,
// etc.). 2019 is a conservative lower bound for the IL Solar RPS book;
// 2042 = 2027 Schedule B's 15th year.
const SCHEDULE_YEAR_BOUNDS = { min: 2019, max: 2042 };

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

  // Guard against partial-hydration fluctuation.
  //
  // During progressive dataset hydration the transferHistory and
  // deliveryScheduleBase datasets don't arrive atomically. The
  // problematic ordering is transferHistory landing first: with
  // scheduleRows empty, systemSchedules is empty too, and the loop
  // below reports EVERY transfer as unmatched (~250K). Once Schedule B
  // lands the count collapses to the real figure (~6K). That
  // transient makes the Delivery Tracker card oscillate 6k ↔ 250k
  // during mount and whenever a user force-syncs transferHistory.
  //
  // Short-circuit only in that specific ordering — transfers present,
  // schedules absent. The inverse (schedules present, transfers
  // empty) is a legitimate state because contracts are derivable from
  // Schedule B alone; existing tests assert that structure.
  if (scheduleRows.length === 0 && transferRows.length > 0) {
    return EMPTY_DELIVERY_TRACKER_DATA;
  }

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

  // Diagnostic: find scraped Schedule Bs with year boundaries outside
  // the plausible [2019, 2042] window. These are strong candidates for
  // bad PDF parses driving large year_mismatch / pre_delivery counts.
  // We collect the offending year rows per system so the UI can show
  // exactly what the parser produced.
  const schedulesWithYearsOutsideBoundsList: FlaggedSchedule[] = [];
  systemSchedules.forEach((schedule) => {
    const offending: OutOfBoundsYear[] = [];
    for (const year of schedule.years) {
      const startYear = year.yearStart?.getFullYear() ?? null;
      const endYear = year.yearEnd?.getFullYear() ?? null;
      const startOut =
        typeof startYear === "number" &&
        (startYear < SCHEDULE_YEAR_BOUNDS.min ||
          startYear > SCHEDULE_YEAR_BOUNDS.max);
      const endOut =
        typeof endYear === "number" &&
        (endYear < SCHEDULE_YEAR_BOUNDS.min ||
          endYear > SCHEDULE_YEAR_BOUNDS.max);
      if (startOut || endOut) {
        offending.push({
          yearLabel: year.yearLabel,
          startYear,
          endYear,
        });
      }
    }
    if (offending.length > 0) {
      schedulesWithYearsOutsideBoundsList.push({
        trackingId: schedule.unitId,
        systemName: schedule.systemName,
        outOfBoundsYears: offending,
      });
    }
  });
  schedulesWithYearsOutsideBoundsList.sort((a, b) =>
    a.trackingId.localeCompare(b.trackingId),
  );

  // Process transfers: allocate to energy years
  let totalTransfers = 0;
  let unmatchedTransfers = 0;
  // Tracking IDs that have at least one utility transfer but no matching
  // Schedule B obligation, mapped to the count of such transfers.
  // Surfaced in the UI so the user can see which Schedule B PDFs still
  // need scraping and how much transfer volume each gap represents.
  const transfersMissingObligationCounts = new Map<string, number>();
  // Tracking IDs whose Schedule B exists but no year slot matched the
  // transfer completion date. See `transfersUnmatchedByYear` docstring.
  const transfersUnmatchedByYearCounts = new Map<string, number>();
  // Tracking IDs whose Schedule B exists and transfer ran BEFORE the
  // earliest scraped year_start. See `transfersPreDeliverySchedule`.
  const transfersPreDeliveryScheduleCounts = new Map<string, number>();

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
      transfersMissingObligationCounts.set(
        unitId,
        (transfersMissingObligationCounts.get(unitId) ?? 0) + 1,
      );
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
      if (!matched) {
        // Classify the unmatched transfer. If its completion date is
        // BEFORE the system's earliest scraped year_start, it's a
        // pre-delivery-schedule transfer — real transfer, just before
        // the contract window. Pre-delivery transfers are NOT counted
        // toward `unmatchedTransfers` (the summary-card counter); they
        // are tracked separately so the Unmatched Transfers total
        // reflects only truly anomalous matches (bad parse /
        // after-contract / etc.).
        let earliestStart: Date | null = null;
        for (const year of schedule.years) {
          if (!year.yearStart) continue;
          if (!earliestStart || year.yearStart < earliestStart) {
            earliestStart = year.yearStart;
          }
        }
        if (earliestStart && completionDate < earliestStart) {
          transfersPreDeliveryScheduleCounts.set(
            unitId,
            (transfersPreDeliveryScheduleCounts.get(unitId) ?? 0) + 1,
          );
        } else {
          unmatchedTransfers++;
          transfersUnmatchedByYearCounts.set(
            unitId,
            (transfersUnmatchedByYearCounts.get(unitId) ?? 0) + 1,
          );
        }
      }
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
    transfersMissingObligation: toSortedBucket(
      transfersMissingObligationCounts,
    ),
    transfersUnmatchedByYear: toSortedBucket(transfersUnmatchedByYearCounts),
    transfersPreDeliverySchedule: toSortedBucket(
      transfersPreDeliveryScheduleCounts,
    ),
    schedulesWithYearsOutsideBounds: schedulesWithYearsOutsideBoundsList,
  };
}

/**
 * Convert a tracking-ID → count Map into a sorted `TransferBucketEntry[]`.
 * Extracted because the builder returns three fields with identical
 * shape and sort rules.
 */
function toSortedBucket(counts: Map<string, number>): TransferBucketEntry[] {
  return Array.from(counts, ([trackingId, transferCount]) => ({
    trackingId,
    transferCount,
  })).sort((a, b) => a.trackingId.localeCompare(b.trackingId));
}
