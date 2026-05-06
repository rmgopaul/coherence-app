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
 * Task 5.13 cleanup (2026-04-27) — pure parsing helpers (`clean`,
 * `parseNumber`, `parseDate`, `toPercentValue`) moved to
 * `aggregatorHelpers.ts` and the cache state machine is now the
 * generic `withArtifactCache` wrapper. `formatDate`,
 * `buildDeliveryYearLabel`, and `UTILITY_PATTERNS` stay local —
 * they're specific to delivery-tracker semantics and not reused by
 * other aggregators.
 *
 * The pure function `buildDeliveryTrackerData` is a structural copy of
 * `client/src/solar-rec-dashboard/lib/buildDeliveryTrackerData.ts`.
 * Divergence detector: the matched `.test.ts` files on each side
 * (the client copy lives at
 * `client/src/solar-rec-dashboard/lib/buildDeliveryTrackerData.test.ts`).
 */

import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  srDsDeliverySchedule,
  srDsTransferHistory,
} from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import { buildCsvText } from "../../routers/helpers/scheduleB";
import {
  type CsvRow,
  clean,
  parseDate,
  parseNumber,
  toPercentValue,
} from "./aggregatorHelpers";
import { loadDatasetRowsPage } from "./buildSystemSnapshot";
import { superjsonSerde, withArtifactCache } from "./withArtifactCache";

// ---------------------------------------------------------------------------
// Local helpers — specific to delivery-tracker semantics.
// ---------------------------------------------------------------------------

/** Internal — only called by `buildDeliveryYearLabel` below. */
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
  detailRowCount: number;
  detailRowsTruncated: boolean;
  detailRowLimit: number | null;
  contracts: DeliveryTrackerContractSummary[];
  totalTransfers: number;
  unmatchedTransfers: number;
  scheduleIdSample: string[];
  transferIdSample: string[];
  scheduleCount: number;
  diagnosticRowLimit: number | null;
  diagnosticRowsTruncated: boolean;
  missingObligationTrackingIdCount: number;
  unmatchedByYearTrackingIdCount: number;
  preDeliveryScheduleTrackingIdCount: number;
  schedulesWithYearsOutsideBoundsCount: number;
  transfersMissingObligation: TransferBucketEntry[];
  transfersUnmatchedByYear: TransferBucketEntry[];
  transfersPreDeliverySchedule: TransferBucketEntry[];
  schedulesWithYearsOutsideBounds: FlaggedSchedule[];
};

export const EMPTY_DELIVERY_TRACKER_DATA: DeliveryTrackerData = Object.freeze({
  rows: [],
  detailRowCount: 0,
  detailRowsTruncated: false,
  detailRowLimit: null,
  contracts: [],
  totalTransfers: 0,
  unmatchedTransfers: 0,
  scheduleIdSample: [],
  transferIdSample: [],
  scheduleCount: 0,
  diagnosticRowLimit: null,
  diagnosticRowsTruncated: false,
  missingObligationTrackingIdCount: 0,
  unmatchedByYearTrackingIdCount: 0,
  preDeliveryScheduleTrackingIdCount: 0,
  schedulesWithYearsOutsideBoundsCount: 0,
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

type BuildDeliveryTrackerOptions = {
  /**
   * Maximum number of system-year detail rows to return. Contract
   * totals and diagnostics are still computed from every schedule row.
   * Null means return every detail row, preserving the original pure
   * helper behavior for parity tests and explicit exports.
   */
  detailRowLimit?: number | null;
  /**
   * Maximum number of diagnostic bucket rows to return. Full counts
   * and CSV exports are still computed from the complete maps.
   * Null means return every diagnostic row for parity tests.
   */
  diagnosticRowLimit?: number | null;
};

export interface DeliveryTrackerDetailCsvArtifact {
  csv?: string;
  filePath?: string;
  fileName: string;
  rowCount: number;
  csvBytes: number;
  cleanup?: () => Promise<void>;
}

export interface DeliveryTrackerAccumulator {
  processScheduleRow: (row: CsvRow) => void;
  processTransferRow: (row: CsvRow) => void;
  finish: () => DeliveryTrackerData;
  writeDetailCsvFile: (
    generatedAtIso?: string
  ) => Promise<DeliveryTrackerDetailCsvArtifact>;
  writeUnmatchedTransferCsvFile: (
    generatedAtIso?: string
  ) => Promise<DeliveryTrackerDetailCsvArtifact>;
}

// ---------------------------------------------------------------------------
// Pure aggregator — identical logic to the client version. Tested by the
// sibling `.test.ts`.
// ---------------------------------------------------------------------------

export function buildDeliveryTrackerData(input: {
  scheduleRows: CsvRow[];
  transferRows: CsvRow[];
  options?: BuildDeliveryTrackerOptions;
}): DeliveryTrackerData {
  const { scheduleRows, transferRows, options } = input;

  if (scheduleRows.length === 0 && transferRows.length > 0) {
    return EMPTY_DELIVERY_TRACKER_DATA;
  }

  const accumulator = createDeliveryTrackerAccumulator(scheduleRows, options);
  for (const row of transferRows) {
    accumulator.processTransferRow(row);
  }
  return accumulator.finish();
}

export function createDeliveryTrackerAccumulator(
  scheduleRows: CsvRow[],
  options: BuildDeliveryTrackerOptions = {}
): DeliveryTrackerAccumulator {
  const detailRowLimit = options.detailRowLimit ?? null;
  const diagnosticRowLimit = options.diagnosticRowLimit ?? null;

  const systemSchedules = new Map<string, SystemSchedule>();

  const processScheduleRow = (row: CsvRow) => {
    const unitId = clean(row.tracking_system_ref_id);
    if (!unitId) return;
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
  };

  for (const row of scheduleRows) {
    processScheduleRow(row);
  }

  const buildSchedulesWithYearsOutsideBoundsList = (): FlaggedSchedule[] => {
    const flagged: FlaggedSchedule[] = [];
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
        flagged.push({
          trackingId: schedule.unitId,
          systemName: schedule.systemName,
          outOfBoundsYears: offending,
        });
      }
    });
    return flagged.sort((a, b) => a.trackingId.localeCompare(b.trackingId));
  };

  let totalTransfers = 0;
  let unmatchedTransfers = 0;
  let sampledTransferRows = 0;
  const transferIdSampleSet = new Set<string>();
  const transfersMissingObligationCounts = new Map<string, number>();
  const transfersUnmatchedByYearCounts = new Map<string, number>();
  const transfersPreDeliveryScheduleCounts = new Map<string, number>();

  const processTransferRow = (row: CsvRow) => {
    if (sampledTransferRows < 100) {
      sampledTransferRows += 1;
      const sampleUnitId = clean(row["Unit ID"]).toLowerCase();
      if (sampleUnitId && transferIdSampleSet.size < 5) {
        transferIdSampleSet.add(sampleUnitId);
      }
    }
    if (systemSchedules.size === 0) return;

    const unitId = clean(row["Unit ID"]);
    if (!unitId) return;
    const qty = parseNumber(row.Quantity) ?? 0;
    if (qty === 0) return;

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
    else return;

    totalTransfers++;

    const completionDateRaw = clean(row["Transfer Completion Date"]);
    const completionDate = completionDateRaw
      ? parseDate(completionDateRaw)
      : null;
    if (!completionDate) return;

    const schedule = systemSchedules.get(unitId.toLowerCase());
    if (!schedule) {
      unmatchedTransfers++;
      transfersMissingObligationCounts.set(
        unitId,
        (transfersMissingObligationCounts.get(unitId) ?? 0) + 1
      );
      return;
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
  };

  const finish = (): DeliveryTrackerData => {
    const rows: DeliveryTrackerRow[] = [];
    const contractAgg = new Map<string, DeliveryTrackerContractSummary>();
    let detailRowCount = 0;

    systemSchedules.forEach((schedule) => {
      for (const year of schedule.years) {
        const detailRow = buildDetailRow(schedule, year);
        detailRowCount += 1;
        if (detailRowLimit === null || rows.length < detailRowLimit) {
          rows.push(detailRow);
        }

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
        c.totalGap += detailRow.gap;
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
    const missingObligationTrackingIdCount =
      transfersMissingObligationCounts.size;
    const unmatchedByYearTrackingIdCount =
      transfersUnmatchedByYearCounts.size;
    const preDeliveryScheduleTrackingIdCount =
      transfersPreDeliveryScheduleCounts.size;
    const schedulesWithYearsOutsideBoundsList =
      buildSchedulesWithYearsOutsideBoundsList();
    const schedulesWithYearsOutsideBoundsCount =
      schedulesWithYearsOutsideBoundsList.length;
    const transfersMissingObligation = toSortedBucket(
      transfersMissingObligationCounts,
      diagnosticRowLimit
    );
    const transfersUnmatchedByYear = toSortedBucket(
      transfersUnmatchedByYearCounts,
      diagnosticRowLimit
    );
    const transfersPreDeliverySchedule = toSortedBucket(
      transfersPreDeliveryScheduleCounts,
      diagnosticRowLimit
    );
    const schedulesWithYearsOutsideBounds =
      limitRows(schedulesWithYearsOutsideBoundsList, diagnosticRowLimit);
    const diagnosticRowsTruncated =
      (diagnosticRowLimit !== null &&
        (missingObligationTrackingIdCount > diagnosticRowLimit ||
          unmatchedByYearTrackingIdCount > diagnosticRowLimit ||
          preDeliveryScheduleTrackingIdCount > diagnosticRowLimit ||
          schedulesWithYearsOutsideBoundsCount > diagnosticRowLimit));

    return {
      rows,
      detailRowCount,
      detailRowsTruncated:
        detailRowLimit !== null && detailRowCount > detailRowLimit,
      detailRowLimit,
      contracts,
      totalTransfers,
      unmatchedTransfers,
      scheduleIdSample,
      transferIdSample: Array.from(transferIdSampleSet),
      scheduleCount: systemSchedules.size,
      diagnosticRowLimit,
      diagnosticRowsTruncated,
      missingObligationTrackingIdCount,
      unmatchedByYearTrackingIdCount,
      preDeliveryScheduleTrackingIdCount,
      schedulesWithYearsOutsideBoundsCount,
      transfersMissingObligation,
      transfersUnmatchedByYear,
      transfersPreDeliverySchedule,
      schedulesWithYearsOutsideBounds,
    };
  };

  const writeDetailCsvFile = async (
    generatedAtIso: string = new Date().toISOString()
  ): Promise<DeliveryTrackerDetailCsvArtifact> => {
    const fileName = `delivery-tracker-detail-${timestampForCsvFileName(
      generatedAtIso
    )}.csv`;
    if (systemSchedules.size === 0) {
      return { csv: "", fileName, rowCount: 0, csvBytes: 0 };
    }

    let tempDir: string | null = null;
    let wroteFirstChunk = false;
    let rowCount = 0;
    const buffer: Record<string, string>[] = [];

    async function flush(): Promise<void> {
      if (!tempDir || buffer.length === 0) return;
      const text = buildCsvText(DELIVERY_TRACKER_DETAIL_CSV_HEADERS, buffer);
      if (!wroteFirstChunk) {
        await writeFile(path.join(tempDir, fileName), text, "utf8");
        wroteFirstChunk = true;
      } else {
        const newlineIdx = text.indexOf("\n");
        const body = newlineIdx >= 0 ? text.slice(newlineIdx + 1) : "";
        await appendFile(path.join(tempDir, fileName), `\n${body}`, "utf8");
      }
      buffer.length = 0;
    }

    try {
      tempDir = await mkdtemp(path.join(tmpdir(), "solar-rec-delivery-detail-"));
      const schedules = Array.from(systemSchedules.values());
      for (const schedule of schedules) {
        for (const year of schedule.years) {
          buffer.push(detailRowToCsvRecord(buildDetailRow(schedule, year)));
          rowCount += 1;
          if (buffer.length >= DELIVERY_TRACKER_DETAIL_CSV_CHUNK_ROWS) {
            await flush();
          }
        }
      }
      await flush();

      if (rowCount === 0 || !wroteFirstChunk) {
        await rm(tempDir, { recursive: true, force: true });
        tempDir = null;
        return { csv: "", fileName, rowCount: 0, csvBytes: 0 };
      }

      const filePath = path.join(tempDir, fileName);
      const csvBytes = (await stat(filePath)).size;
      const cleanup = async () => {
        if (!tempDir) return;
        await rm(tempDir, { recursive: true, force: true });
        tempDir = null;
      };

      return { filePath, fileName, rowCount, csvBytes, cleanup };
    } catch (err) {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(
          () => undefined
        );
      }
      throw err;
    }
  };

  const writeUnmatchedTransferCsvFile = async (
    generatedAtIso: string = new Date().toISOString()
  ): Promise<DeliveryTrackerDetailCsvArtifact> => {
    const fileName =
      `delivery-tracker-unmatched-transfers-${timestampForCsvFileName(
        generatedAtIso
      )}.csv`;
    return writeUnmatchedTransferCsvFileArtifact({
      fileName,
      buckets: [
        {
          counts: transfersMissingObligationCounts,
          bucket: DELIVERY_TRACKER_TRANSFER_BUCKETS.missingScheduleB,
        },
        {
          counts: transfersPreDeliveryScheduleCounts,
          bucket: DELIVERY_TRACKER_TRANSFER_BUCKETS.preDeliverySchedule,
        },
        {
          counts: transfersUnmatchedByYearCounts,
          bucket: DELIVERY_TRACKER_TRANSFER_BUCKETS.yearMismatch,
        },
      ],
    });
  };

  return {
    processScheduleRow,
    processTransferRow,
    finish,
    writeDetailCsvFile,
    writeUnmatchedTransferCsvFile,
  };
}

function buildDetailRow(
  schedule: SystemSchedule,
  year: YearSlot
): DeliveryTrackerRow {
  const gap = year.obligated - year.delivered;
  return {
    systemName: schedule.systemName,
    unitId: schedule.unitId,
    contractId: schedule.contractId,
    yearLabel: year.yearLabel,
    yearStart: year.yearStart,
    yearEnd: year.yearEnd,
    obligated: year.obligated,
    delivered: year.delivered,
    gap,
  };
}

const DELIVERY_TRACKER_DETAIL_CSV_HEADERS = [
  "system_name",
  "unit_id",
  "contract",
  "year",
  "start_date",
  "end_date",
  "obligated",
  "delivered",
  "gap",
];

const DELIVERY_TRACKER_DETAIL_CSV_CHUNK_ROWS = 1000;

const DELIVERY_TRACKER_UNMATCHED_TRANSFER_CSV_HEADERS = [
  "tracking_system_ref_id",
  "bucket",
  "transfer_count",
];

const DELIVERY_TRACKER_TRANSFER_BUCKETS = {
  missingScheduleB: "missing_schedule_b",
  preDeliverySchedule: "pre_delivery_schedule",
  yearMismatch: "year_mismatch",
} as const;

type DeliveryTrackerTransferBucket =
  (typeof DELIVERY_TRACKER_TRANSFER_BUCKETS)[keyof typeof DELIVERY_TRACKER_TRANSFER_BUCKETS];

type DeliveryTrackerUnmatchedTransferBucketSource = {
  counts: ReadonlyMap<string, number>;
  bucket: DeliveryTrackerTransferBucket;
};

function detailRowToCsvRecord(row: DeliveryTrackerRow): Record<string, string> {
  return {
    system_name: row.systemName,
    unit_id: row.unitId,
    contract: row.contractId,
    year: row.yearLabel,
    start_date: row.yearStart?.toISOString().slice(0, 10) ?? "",
    end_date: row.yearEnd?.toISOString().slice(0, 10) ?? "",
    obligated: String(row.obligated),
    delivered: String(row.delivered),
    gap: String(row.gap),
  };
}

function timestampForCsvFileName(iso: string): string {
  return iso.replace(/[^0-9]/g, "").slice(0, 14);
}

async function writeUnmatchedTransferCsvFileArtifact(input: {
  fileName: string;
  buckets: readonly DeliveryTrackerUnmatchedTransferBucketSource[];
}): Promise<DeliveryTrackerDetailCsvArtifact> {
  let tempDir: string | null = null;
  let wroteFirstChunk = false;
  let rowCount = 0;

  async function flush(buffer: Record<string, string>[]): Promise<void> {
    if (!tempDir || buffer.length === 0) return;
    const text = buildCsvText(
      DELIVERY_TRACKER_UNMATCHED_TRANSFER_CSV_HEADERS,
      buffer
    );
    if (!wroteFirstChunk) {
      await writeFile(path.join(tempDir, input.fileName), text, "utf8");
      wroteFirstChunk = true;
    } else {
      const newlineIdx = text.indexOf("\n");
      const body = newlineIdx >= 0 ? text.slice(newlineIdx + 1) : "";
      await appendFile(path.join(tempDir, input.fileName), `\n${body}`, "utf8");
    }
    buffer.length = 0;
  }

  try {
    tempDir = await mkdtemp(path.join(tmpdir(), "solar-rec-delivery-unmatched-"));
    const buffer: Record<string, string>[] = [];
    for (const source of input.buckets) {
      const entries = Array.from(source.counts.entries()).sort(
        ([left], [right]) => left.localeCompare(right)
      );
      for (const [trackingId, transferCount] of entries) {
        buffer.push({
          tracking_system_ref_id: trackingId,
          bucket: source.bucket,
          transfer_count: String(transferCount),
        });
        rowCount += 1;
        if (buffer.length >= DELIVERY_TRACKER_DETAIL_CSV_CHUNK_ROWS) {
          await flush(buffer);
        }
      }
    }
    await flush(buffer);

    if (!wroteFirstChunk) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
      return { csv: "", fileName: input.fileName, rowCount: 0, csvBytes: 0 };
    }

    const filePath = path.join(tempDir, input.fileName);
    const csvBytes = (await stat(filePath)).size;
    const cleanup = async () => {
      if (!tempDir) return;
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    };

    return {
      filePath,
      fileName: input.fileName,
      rowCount,
      csvBytes,
      cleanup,
    };
  } catch (err) {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
    throw err;
  }
}

function limitRows<T>(rows: T[], limit: number | null): T[] {
  return limit === null ? rows : rows.slice(0, limit);
}

function toSortedBucket(
  counts: Map<string, number>,
  limit: number | null = null
): TransferBucketEntry[] {
  const rows = Array.from(counts, ([trackingId, transferCount]) => ({
    trackingId,
    transferCount,
  })).sort((a, b) => a.trackingId.localeCompare(b.trackingId));
  return limitRows(rows, limit);
}

// ---------------------------------------------------------------------------
// Cached server entrypoint — what the tRPC query calls.
// ---------------------------------------------------------------------------

const DELIVERY_TRACKER_DEPS = ["deliveryScheduleBase", "transferHistory"] as const;

const ARTIFACT_TYPE = "deliveryTracker_compact_v4";

export const DELIVERY_TRACKER_RUNNER_VERSION =
  "data-flow-pr5_13_deliverytracker@4-schedule-paged";

const DELIVERY_TRACKER_DETAIL_PREVIEW_LIMIT = 200;
const DELIVERY_TRACKER_DIAGNOSTIC_PREVIEW_LIMIT = 200;
const DELIVERY_TRACKER_SCHEDULE_PAGE_SIZE = 5_000;
const DELIVERY_TRACKER_TRANSFER_PAGE_SIZE = 25_000;

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
 * `fromCache` flag for visibility in devtools.
 *
 * Cache strategy: `withArtifactCache` keyed by a SHA-256 of the
 * active batch IDs for `deliveryScheduleBase` and `transferHistory`.
 * Cache miss recomputes inline (no async run-claim dance — the
 * aggregate is small, sub-second on prod data) and writes back.
 * superjson serde because `yearStart` / `yearEnd` are `Date` fields.
 */
export async function getOrBuildDeliveryTrackerData(
  scopeId: string
): Promise<DeliveryTrackerData & { fromCache: boolean }> {
  const { hash, versionMap } = await computeDeliveryTrackerInputHash(scopeId);
  const deliveryScheduleBatchId = versionMap.get("deliveryScheduleBase") ?? null;
  const transferHistoryBatchId = versionMap.get("transferHistory") ?? null;

  // No active Schedule B row table means every transfer would be
  // classified as missing obligation. Return before touching
  // transferHistory so the tab cannot OOM just because transfer
  // history exists without Schedule B coverage.
  if (!deliveryScheduleBatchId) {
    return { ...EMPTY_DELIVERY_TRACKER_DATA, fromCache: false };
  }

  const { result, fromCache } = await withArtifactCache<DeliveryTrackerData>({
    scopeId,
    artifactType: ARTIFACT_TYPE,
    inputVersionHash: hash,
    serde: superjsonSerde<DeliveryTrackerData>(),
    rowCount: (data) => data.detailRowCount,
    recompute: async () => {
      const { accumulator, rawScheduleRowCount } =
        await loadDeliveryScheduleRowsIntoAccumulator(
          scopeId,
          deliveryScheduleBatchId,
          {
            detailRowLimit: DELIVERY_TRACKER_DETAIL_PREVIEW_LIMIT,
            diagnosticRowLimit: DELIVERY_TRACKER_DIAGNOSTIC_PREVIEW_LIMIT,
          }
        );

      if (rawScheduleRowCount === 0) {
        return EMPTY_DELIVERY_TRACKER_DATA;
      }

      if (transferHistoryBatchId) {
        await streamTransferHistoryRowsIntoAccumulator(
          scopeId,
          transferHistoryBatchId,
          accumulator
        );
      }

      return accumulator.finish();
    },
  });

  return { ...result, fromCache };
}

async function loadDeliveryScheduleRowsIntoAccumulator(
  scopeId: string,
  deliveryScheduleBatchId: string,
  options: BuildDeliveryTrackerOptions
): Promise<{
  accumulator: DeliveryTrackerAccumulator;
  rawScheduleRowCount: number;
}> {
  const accumulator = createDeliveryTrackerAccumulator([], options);
  let cursor: string | null = null;
  let rawScheduleRowCount = 0;

  for (;;) {
    const page = await loadDatasetRowsPage(
      scopeId,
      deliveryScheduleBatchId,
      srDsDeliverySchedule,
      {
        cursor,
        limit: DELIVERY_TRACKER_SCHEDULE_PAGE_SIZE,
      }
    );
    for (const row of page.rows) {
      rawScheduleRowCount += 1;
      accumulator.processScheduleRow(row);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return { accumulator, rawScheduleRowCount };
}

async function streamTransferHistoryRowsIntoAccumulator(
  scopeId: string,
  transferHistoryBatchId: string,
  accumulator: Pick<DeliveryTrackerAccumulator, "processTransferRow">
): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    const page = await loadDatasetRowsPage(
      scopeId,
      transferHistoryBatchId,
      srDsTransferHistory,
      {
        cursor,
        limit: DELIVERY_TRACKER_TRANSFER_PAGE_SIZE,
      }
    );
    for (const row of page.rows) {
      accumulator.processTransferRow(row);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
}

export async function buildDeliveryTrackerDetailCsvExport(
  scopeId: string,
  generatedAtIso: string = new Date().toISOString()
): Promise<DeliveryTrackerDetailCsvArtifact> {
  const { versionMap } = await computeDeliveryTrackerInputHash(scopeId);
  const deliveryScheduleBatchId = versionMap.get("deliveryScheduleBase") ?? null;
  const transferHistoryBatchId = versionMap.get("transferHistory") ?? null;
  const fileName = `delivery-tracker-detail-${timestampForCsvFileName(
    generatedAtIso
  )}.csv`;

  if (!deliveryScheduleBatchId) {
    return { csv: "", fileName, rowCount: 0, csvBytes: 0 };
  }

  const { accumulator, rawScheduleRowCount } =
    await loadDeliveryScheduleRowsIntoAccumulator(
      scopeId,
      deliveryScheduleBatchId,
      {
        detailRowLimit: 0,
        diagnosticRowLimit: 0,
      }
    );
  if (rawScheduleRowCount === 0) {
    return { csv: "", fileName, rowCount: 0, csvBytes: 0 };
  }

  if (transferHistoryBatchId) {
    await streamTransferHistoryRowsIntoAccumulator(
      scopeId,
      transferHistoryBatchId,
      accumulator
    );
  }

  return accumulator.writeDetailCsvFile(generatedAtIso);
}

export async function buildDeliveryTrackerUnmatchedTransfersCsvExport(
  scopeId: string,
  generatedAtIso: string = new Date().toISOString()
): Promise<DeliveryTrackerDetailCsvArtifact> {
  const { versionMap } = await computeDeliveryTrackerInputHash(scopeId);
  const deliveryScheduleBatchId = versionMap.get("deliveryScheduleBase") ?? null;
  const transferHistoryBatchId = versionMap.get("transferHistory") ?? null;
  const fileName =
    `delivery-tracker-unmatched-transfers-${timestampForCsvFileName(
      generatedAtIso
    )}.csv`;

  if (!deliveryScheduleBatchId) {
    return { csv: "", fileName, rowCount: 0, csvBytes: 0 };
  }

  const { accumulator, rawScheduleRowCount } =
    await loadDeliveryScheduleRowsIntoAccumulator(
      scopeId,
      deliveryScheduleBatchId,
      {
        detailRowLimit: 0,
        diagnosticRowLimit: 0,
      }
    );
  if (rawScheduleRowCount === 0) {
    return { csv: "", fileName, rowCount: 0, csvBytes: 0 };
  }

  if (transferHistoryBatchId) {
    await streamTransferHistoryRowsIntoAccumulator(
      scopeId,
      transferHistoryBatchId,
      accumulator
    );
  }

  return accumulator.writeUnmatchedTransferCsvFile(generatedAtIso);
}
