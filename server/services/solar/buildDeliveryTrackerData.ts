/**
 * Server-side Delivery Tracker aggregator.
 *
 * Task 5.13 PR-1 (2026-04-27) — moves the parent-level
 * `useMemo(() => buildDeliveryTrackerData({...}))` call out of
 * `client/src/features/solar-rec/SolarRecDashboard.tsx` and onto the
 * server. The client now hits `getDashboardDeliveryTrackerAggregates`
 * via tRPC and receives the same `DeliveryTrackerData` shape it used
 * to build locally — no `datasets[key].rows` materialization needed.
 *
 * The pure function `buildDeliveryTrackerData` is a structural copy of
 * `client/src/solar-rec-dashboard/lib/buildDeliveryTrackerData.ts`;
 * the helpers it needs (`clean`, `parseNumber`, `parseDate`,
 * `buildDeliveryYearLabel`, `toPercentValue`, `UTILITY_PATTERNS`) are
 * inlined in this file rather than reaching into client/lib because:
 *   1. server code can't depend on `@/lib/helpers`;
 *   2. moving the client helpers to `shared/` would touch ~50 files;
 *   3. the helpers are small and stable.
 *
 * If a follow-up wants to consolidate, the right move is to keep this
 * file as the SOT and have the client import from a thin re-export
 * shim. For now, the in-source duplication is gated by the unit
 * test in this file's sibling `.test.ts`, which mirrors the client's
 * existing `buildDeliveryTrackerData.test.ts` so divergence shows up
 * in CI.
 */

import { createHash } from "node:crypto";
import superjson from "superjson";
import { srDsDeliverySchedule, srDsTransferHistory } from "../../../drizzle/schemas/solar";
import {
  getActiveVersionsForKeys,
  getComputedArtifact,
  upsertComputedArtifact,
} from "../../db/solarRecDatasets";
import { loadDatasetRows } from "./buildSystemSnapshot";

type CsvRow = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Inlined helpers (parallel implementations of client/src/solar-rec-dashboard
// /lib/parsers.ts + constants.ts). Keep these byte-equivalent to the client
// versions; the test file asserts a fixed fixture aggregates identically on
// both sides.
// ---------------------------------------------------------------------------

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseNumber(value: string | undefined): number | null {
  const cleaned = clean(value).replace(/[$,%\s]/g, "").replaceAll(",", "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: string | undefined): Date | null {
  const raw = clean(value);
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]) - 1;
    const day = Number(iso[3]);
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const usDateTime = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?)?$/
  );
  if (usDateTime) {
    const month = Number(usDateTime[1]) - 1;
    const day = Number(usDateTime[2]);
    const year =
      Number(usDateTime[3]) < 100
        ? 2000 + Number(usDateTime[3])
        : Number(usDateTime[3]);
    let hours = usDateTime[4] ? Number(usDateTime[4]) : 0;
    const minutes = usDateTime[5] ? Number(usDateTime[5]) : 0;
    const meridiem = usDateTime[6]?.toUpperCase();

    if (meridiem === "PM" && hours < 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;

    const date = new Date(year, month, day, hours, minutes);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function formatDate(value: Date | null): string {
  if (!value) return "N/A";
  return value.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function buildDeliveryYearLabel(
  start: Date | null,
  end: Date | null,
  startRaw: string,
  endRaw: string
): string {
  if (start && end) return `${start.getFullYear()}-${end.getFullYear()}`;
  if (startRaw && endRaw) return `${startRaw} to ${endRaw}`;
  if (startRaw) return startRaw;
  if (start) return formatDate(start);
  return "Unknown";
}

function toPercentValue(numerator: number, denominator: number): number | null {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null;
  }
  return (numerator / denominator) * 100;
}

const UTILITY_PATTERNS = ["comed", "ameren", "midamerican"] as const;

// ---------------------------------------------------------------------------
// Output types — kept structurally identical to the client version so the
// existing `DeliveryTrackerTab` props don't need to change. Dates serialize
// over the wire as ISO strings (tRPC's superjson handles the round-trip).
// ---------------------------------------------------------------------------

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

export type TransferBucketEntry = {
  trackingId: string;
  transferCount: number;
};

export type OutOfBoundsYear = {
  yearLabel: string;
  startYear: number | null;
  endYear: number | null;
};

export type FlaggedSchedule = {
  trackingId: string;
  systemName: string;
  outOfBoundsYears: OutOfBoundsYear[];
};

export type DeliveryTrackerData = {
  rows: DeliveryTrackerRow[];
  contracts: DeliveryTrackerContractSummary[];
  totalTransfers: number;
  unmatchedTransfers: number;
  scheduleIdSample: string[];
  transferIdSample: string[];
  scheduleCount: number;
  transfersMissingObligation: TransferBucketEntry[];
  transfersUnmatchedByYear: TransferBucketEntry[];
  transfersPreDeliverySchedule: TransferBucketEntry[];
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

// ---------------------------------------------------------------------------
// Pure aggregator — identical logic to the client version. Tested by the
// sibling `.test.ts`.
// ---------------------------------------------------------------------------

export function buildDeliveryTrackerData(input: {
  scheduleRows: CsvRow[];
  transferRows: CsvRow[];
}): DeliveryTrackerData {
  const { scheduleRows, transferRows } = input;

  if (scheduleRows.length === 0 && transferRows.length > 0) {
    return EMPTY_DELIVERY_TRACKER_DATA;
  }

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
      systemSchedules.set(unitId.toLowerCase(), {
        systemName,
        unitId,
        contractId,
        years,
      });
    }
  }

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
    a.trackingId.localeCompare(b.trackingId)
  );

  let totalTransfers = 0;
  let unmatchedTransfers = 0;
  const transfersMissingObligationCounts = new Map<string, number>();
  const transfersUnmatchedByYearCounts = new Map<string, number>();
  const transfersPreDeliveryScheduleCounts = new Map<string, number>();

  for (const row of transferRows) {
    const unitId = clean(row["Unit ID"]);
    if (!unitId) continue;
    const qty = parseNumber(row.Quantity) ?? 0;
    if (qty === 0) continue;

    const transferor = (clean(row.Transferor) ?? "").toLowerCase();
    const transferee = (clean(row.Transferee) ?? "").toLowerCase();

    let direction = 0;
    const isFromCS = transferor.includes("carbon solutions");
    const isToCS = transferee.includes("carbon solutions");
    const transfereeIsUtility = UTILITY_PATTERNS.some((u) =>
      transferee.includes(u)
    );
    const transferorIsUtility = UTILITY_PATTERNS.some((u) =>
      transferor.includes(u)
    );

    if (isFromCS && transfereeIsUtility) direction = 1;
    else if (transferorIsUtility && isToCS) direction = -1;
    else continue;

    totalTransfers++;

    const completionDateRaw = clean(row["Transfer Completion Date"]);
    const completionDate = completionDateRaw
      ? parseDate(completionDateRaw)
      : null;
    if (!completionDate) continue;

    const schedule = systemSchedules.get(unitId.toLowerCase());
    if (!schedule) {
      unmatchedTransfers++;
      transfersMissingObligationCounts.set(
        unitId,
        (transfersMissingObligationCounts.get(unitId) ?? 0) + 1
      );
      continue;
    }

    let matched = false;
    for (const year of schedule.years) {
      if (!year.yearStart) continue;
      if (year.yearEnd) {
        if (
          completionDate >= year.yearStart &&
          completionDate <= year.yearEnd
        ) {
          year.delivered += qty * direction;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      const completionMonth = completionDate.getMonth();
      const completionYear = completionDate.getFullYear();
      const eyStartYear =
        completionMonth >= 5 ? completionYear : completionYear - 1;
      for (const year of schedule.years) {
        if (!year.yearStart) continue;
        if (year.yearStart.getFullYear() === eyStartYear) {
          year.delivered += qty * direction;
          matched = true;
          break;
        }
      }
      if (!matched) {
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
            (transfersPreDeliveryScheduleCounts.get(unitId) ?? 0) + 1
          );
        } else {
          unmatchedTransfers++;
          transfersUnmatchedByYearCounts.set(
            unitId,
            (transfersUnmatchedByYearCounts.get(unitId) ?? 0) + 1
          );
        }
      }
    }
  }

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
    const c = contractAgg.get(schedule.contractId);
    if (c) c.systems++;
  });

  const contracts = Array.from(contractAgg.values())
    .map((c) => ({
      ...c,
      deliveryPercent: toPercentValue(c.totalDelivered, c.totalObligated),
    }))
    .sort((a, b) =>
      a.contractId.localeCompare(b.contractId, undefined, { numeric: true })
    );

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
      transfersMissingObligationCounts
    ),
    transfersUnmatchedByYear: toSortedBucket(transfersUnmatchedByYearCounts),
    transfersPreDeliverySchedule: toSortedBucket(
      transfersPreDeliveryScheduleCounts
    ),
    schedulesWithYearsOutsideBounds: schedulesWithYearsOutsideBoundsList,
  };
}

function toSortedBucket(counts: Map<string, number>): TransferBucketEntry[] {
  return Array.from(counts, ([trackingId, transferCount]) => ({
    trackingId,
    transferCount,
  })).sort((a, b) => a.trackingId.localeCompare(b.trackingId));
}

// ---------------------------------------------------------------------------
// Cached server entrypoint — what the tRPC query calls.
// ---------------------------------------------------------------------------

const DELIVERY_TRACKER_DEPS = ["deliveryScheduleBase", "transferHistory"] as const;

const ARTIFACT_TYPE = "deliveryTracker";

export const DELIVERY_TRACKER_RUNNER_VERSION = "data-flow-pr5_13_deliverytracker@1";

async function computeDeliveryTrackerInputHash(
  scopeId: string
): Promise<{ hash: string; versionMap: Map<string, string> }> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    DELIVERY_TRACKER_DEPS as unknown as string[]
  );
  const sorted = versions
    .map((v) => `${v.datasetKey}:${v.batchId}`)
    .sort();
  const hash = createHash("sha256")
    .update(sorted.join("|"))
    .digest("hex")
    .slice(0, 16);
  const versionMap = new Map(versions.map((v) => [v.datasetKey, v.batchId]));
  return { hash, versionMap };
}

/**
 * Public entrypoint for the tRPC query. Returns the same
 * `DeliveryTrackerData` the client used to build locally, plus a
 * `_runnerVersion` marker (per the data-flow architecture's hard
 * rule) and a `fromCache` flag for visibility in devtools.
 *
 * Cache strategy: synchronous fast-path through `solarRecComputedArtifacts`
 * keyed by a SHA-256 of the active batch IDs for `deliveryScheduleBase`
 * and `transferHistory`. Cache miss recomputes inline (no async run-claim
 * dance — the aggregate is small, sub-second on prod data) and writes
 * back. Cache hit skips both `loadDatasetRows` calls entirely.
 */
export async function getOrBuildDeliveryTrackerData(
  scopeId: string
): Promise<DeliveryTrackerData & { fromCache: boolean }> {
  const { hash, versionMap } = await computeDeliveryTrackerInputHash(scopeId);

  // No active batches for either dataset → nothing to compute. Return
  // an empty payload (mirrors the client's hydration-guard behavior).
  if (versionMap.size === 0) {
    return { ...EMPTY_DELIVERY_TRACKER_DATA, fromCache: false };
  }

  const cached = await getComputedArtifact(scopeId, ARTIFACT_TYPE, hash);
  if (cached) {
    try {
      // superjson, not JSON.parse — yearStart/yearEnd are Date objects;
      // plain JSON would deserialize them as strings and break the
      // tRPC wire format (which also uses superjson) downstream.
      const parsed = superjson.parse<DeliveryTrackerData>(cached.payload);
      return { ...parsed, fromCache: true };
    } catch {
      // Corrupt cache row — fall through to recompute.
    }
  }

  const [scheduleRows, transferRows] = await Promise.all([
    loadDatasetRows(
      scopeId,
      versionMap.get("deliveryScheduleBase") ?? null,
      srDsDeliverySchedule
    ),
    loadDatasetRows(
      scopeId,
      versionMap.get("transferHistory") ?? null,
      srDsTransferHistory
    ),
  ]);

  const result = buildDeliveryTrackerData({ scheduleRows, transferRows });

  await upsertComputedArtifact({
    scopeId,
    artifactType: ARTIFACT_TYPE,
    inputVersionHash: hash,
    payload: superjson.stringify(result),
    rowCount: result.rows.length,
  });

  return { ...result, fromCache: false };
}
