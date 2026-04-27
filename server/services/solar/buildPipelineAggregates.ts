/**
 * Server-side AppPipelineTab aggregator. Shared by the Pipeline tab's
 * 6 client useMemos:
 *   - `pipelineMonthlyRows` (Part 1 / Part 2 / Interconnected counts +
 *     kW per month from `abpReport` + `generatorDetails` + the system
 *     snapshot's `installedKwAc` fallback).
 *   - `pipelineCashFlowRows` (per-month vendor fee + CC-auth collateral
 *     + additional collateral + project count, joined across
 *     `abpReport` Part-2-verified rows ↦ `abpCsgSystemMapping` ↦
 *     `abpIccReport3Rows` ↦ contract-scan results).
 *   - `pipelineRows3Year` / `pipelineRows12Month` /
 *     `cashFlowRows3Year` / `cashFlowRows12Month`: cheap rolling-
 *     window slices that stay client-side after this PR (the
 *     aggregator returns the full detail arrays; the tab applies the
 *     window filters in-memory).
 *
 * Task 5.13 PR-5 (2026-04-27) — closes the AppPipelineTab side of the
 * tab-migration series. AppPipelineTab is the largest of the
 * Task 5.13 migrations (5 dataset inputs vs. 1–3 in PR-1 through
 * PR-4) so the aggregator splits into two pure functions
 * (`buildPipelineMonthly` + `buildPipelineCashFlow`) with a single
 * cached entrypoint (`getOrBuildAppPipelineAggregates`) that runs
 * both in one pass.
 *
 * Cache key: SHA-256 of (`abpReport` batch | `generatorDetails` batch |
 * `abpCsgSystemMapping` batch | `abpIccReport3Rows` batch | system
 * snapshot hash | contract-scan version | overrides hash | UTC day
 * bucket). The day bucket is needed because the monthly aggregator's
 * `isFuture` filter depends on "today"; without it, a cached
 * aggregate computed yesterday would silently include yesterday's
 * future months when read today.
 *
 * `overrides` (the Financials-tab `localOverrides` map) is passed as
 * tRPC input so users can switch between override sets without
 * polluting the cache. When the overrides change, the input hash
 * changes, the cache misses, and the aggregator recomputes — sub-
 * second on prod-scale inputs since rows are already cached server-
 * side and the snapshot is hot.
 */

import { createHash } from "node:crypto";
import { toDateKey } from "../../../shared/dateKey";
import {
  srDsAbpCsgSystemMapping,
  srDsAbpIccReport3Rows,
  srDsAbpReport,
  srDsGeneratorDetails,
} from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import { getLatestScanResultsByCsgIds } from "../../db/contractScans";
import {
  type CsvRow,
  type SnapshotSystem,
  clean,
  extractSnapshotSystems,
  isPart2VerifiedAbpRow,
  parseDate,
  parseNumber,
  parsePart2VerificationDate,
} from "./aggregatorHelpers";
import {
  computeSystemSnapshotHash,
  getOrBuildSystemSnapshot,
  loadDatasetRows,
} from "./buildSystemSnapshot";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

// ---------------------------------------------------------------------------
// Output types — byte-equivalent to the client's `PipelineMonthRow` /
// `PipelineCashFlowRow` (`client/src/solar-rec-dashboard/state/types.ts`).
// Re-declared here so the server doesn't import client code; the matched
// tests guard against drift.
// ---------------------------------------------------------------------------

export type PipelineMonthRow = {
  /** "YYYY-MM" calendar month. */
  month: string;
  part1Count: number;
  part2Count: number;
  part1KwAc: number;
  part2KwAc: number;
  interconnectedCount: number;
  interconnectedKwAc: number;
  prevPart1Count: number;
  prevPart2Count: number;
  prevPart1KwAc: number;
  prevPart2KwAc: number;
  prevInterconnectedCount: number;
  prevInterconnectedKwAc: number;
};

export type PipelineCashFlowRow = {
  /** "YYYY-MM" cash-flow month (Part-2 verification month + 1). */
  month: string;
  vendorFee: number;
  ccAuthCollateral: number;
  additionalCollateral: number;
  totalCashFlow: number;
  projectCount: number;
  prevVendorFee: number;
  prevCcAuthCollateral: number;
  prevAdditionalCollateral: number;
  prevTotalCashFlow: number;
  prevProjectCount: number;
};

/**
 * Single override entry from the Financials tab's `localOverrides`
 * map. `vfp` and `acp` are percentages (0–100); both are nullable
 * because the override may set only one of the two.
 */
export type PipelineOverride = {
  csgId: string;
  vfp?: number | null;
  acp?: number | null;
};

/**
 * Subset of the contract-scan result row that the cash-flow
 * aggregator reads. Server source is `getLatestScanResultsByCsgIds`
 * → `contractScanResults` table; the client mirror lives at
 * `client/src/solar-rec-dashboard/state/types.ts ::
 * ContractScanResultRow`.
 */
export type PipelineContractScan = {
  csgId: string;
  vendorFeePercent: number | null;
  overrideVendorFeePercent: number | null;
  additionalCollateralPercent: number | null;
  overrideAdditionalCollateralPercent: number | null;
  ccAuthorizationCompleted: boolean | null;
};

// ---------------------------------------------------------------------------
// Pipeline-specific parsing helpers — byte-equivalent to the client
// modules in `client/src/solar-rec-dashboard/lib/helpers/`. Inlined
// here rather than added to `aggregatorHelpers.ts` because they're
// only used by the pipeline aggregator and have idiosyncratic
// behaviours (Part-2 dedupe key, mid-month snap on date-online,
// fuzzy-by-keyword AC-size search).
// ---------------------------------------------------------------------------

/**
 * Mirror of `client/src/solar-rec-dashboard/lib/constants.ts ::
 * GENERATOR_DETAILS_AC_SIZE_HEADERS`. The order matters — earlier
 * headers win in the `parseGeneratorDetailsAcSizeKw` lookup.
 */
const GENERATOR_DETAILS_AC_SIZE_HEADERS = [
  "AC Size (kW)",
  "AC Size kW",
  "System AC Size (kW)",
  "System Size (kW AC)",
  "Inverter Size (kW AC)",
  "Inverter Size kW AC",
  "Nameplate Capacity (kW)",
  "Nameplate Capacity kW",
  "Rated Capacity (kW)",
  "Capacity (kW)",
] as const;

/**
 * Mirror of `client/src/solar-rec-dashboard/lib/helpers/csvIdentity.ts ::
 * getCsvValueByHeader`. Case-insensitive header lookup.
 */
function getCsvValueByHeader(row: CsvRow, headerName: string): string {
  const target = clean(headerName).toLowerCase();
  for (const [header, value] of Object.entries(row)) {
    if (clean(header).toLowerCase() === target) return clean(value);
  }
  return "";
}

/**
 * Mirror of `client/src/solar-rec-dashboard/lib/helpers/csvIdentity.ts ::
 * resolvePart2ProjectIdentity`. Builds a stable dedupe key per ABP
 * row so a given (system, application) pair counts once even if the
 * report exports duplicate it across years.
 */
function resolvePart2ProjectIdentity(
  row: CsvRow,
  index: number
): { dedupeKey: string } {
  const applicationId = clean(row.Application_ID) || clean(row.application_id);
  const portalSystemId = clean(row.system_id);
  const trackingId =
    clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) ||
    clean(row.tracking_system_ref_id);
  const projectName = clean(row.Project_Name) || clean(row.system_name);
  const projectNameKey = projectName.toLowerCase();
  const dedupeKey = portalSystemId
    ? `system:${portalSystemId}`
    : trackingId
      ? `tracking:${trackingId}`
      : applicationId
        ? `application:${applicationId}`
        : projectName
          ? `name:${projectNameKey}`
          : `row:${index}`;
  return { dedupeKey };
}

/**
 * Mirror of `client/src/solar-rec-dashboard/lib/helpers/parsing.ts ::
 * parseAbpAcSizeKw`. Reads the Part-2 AC size with a single canonical
 * header + a case-insensitive fallback.
 */
function parseAbpAcSizeKw(row: CsvRow): number | null {
  return parseNumber(
    row.Inverter_Size_kW_AC_Part_2 ||
      getCsvValueByHeader(row, "Inverter_Size_kW_AC_Part_2")
  );
}

/**
 * Mirror of `client/src/solar-rec-dashboard/lib/helpers/parsing.ts ::
 * parseGeneratorDetailsAcSizeKw`. Tries the canonical header list
 * first, then falls back to a fuzzy match on any column whose name
 * contains "kw" + ("ac" | "capacity" | "nameplate" | "inverter") and
 * does NOT contain "dc".
 */
function parseGeneratorDetailsAcSizeKw(row: CsvRow): number | null {
  for (const header of GENERATOR_DETAILS_AC_SIZE_HEADERS) {
    const parsed = parseNumber(
      row[header] || getCsvValueByHeader(row, header)
    );
    if (parsed !== null) return parsed;
  }

  for (const [header, value] of Object.entries(row)) {
    const normalizedHeader = clean(header).toLowerCase();
    if (!normalizedHeader.includes("kw")) continue;
    if (normalizedHeader.includes("dc")) continue;
    if (
      normalizedHeader.includes("ac") ||
      normalizedHeader.includes("capacity") ||
      normalizedHeader.includes("nameplate") ||
      normalizedHeader.includes("inverter")
    ) {
      const parsed = parseNumber(value);
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

/**
 * Mirror of `client/src/solar-rec-dashboard/lib/helpers/parsing.ts ::
 * parseDateOnlineAsMidMonth`. Accepts month/year ("MM/YYYY",
 * "YYYY-MM") and falls back to `parseDate` for full dates; snaps the
 * day-of-month to the 15th so the bucket aligns with the same month
 * across formats.
 */
function parseDateOnlineAsMidMonth(value: string | undefined): Date | null {
  const raw = clean(value);
  if (!raw) return null;

  const slashMonthYear = raw.match(/^(\d{1,2})[\/-](\d{4})$/);
  if (slashMonthYear) {
    const month = Number(slashMonthYear[1]) - 1;
    const year = Number(slashMonthYear[2]);
    const date = new Date(year, month, 15);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const isoMonthYear = raw.match(/^(\d{4})[\/-](\d{1,2})$/);
  if (isoMonthYear) {
    const year = Number(isoMonthYear[1]);
    const month = Number(isoMonthYear[2]) - 1;
    const date = new Date(year, month, 15);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = parseDate(raw);
  if (!parsed) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), 15);
}

/**
 * Mirror of `client/src/solar-rec-dashboard/lib/helpers/formatting.ts ::
 * roundMoney`. Two decimal places, half-away-from-zero.
 */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** "YYYY-MM" key. */
function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Pure aggregator — Part 1 / Part 2 / Interconnected monthly counts
// ---------------------------------------------------------------------------

/**
 * The pipeline aggregator needs `installedKwAc` (interconnected
 * fallback) on top of the base `SnapshotSystem` shape. Exported
 * because tests build their own system fixtures.
 */
export type PipelineSnapshotSystem = SnapshotSystem & {
  installedKwAc: number | null;
};

export function buildPipelineMonthly(input: {
  abpReportRows: CsvRow[];
  generatorDetailsRows: CsvRow[];
  systems: readonly PipelineSnapshotSystem[];
  /** Defaults to `new Date()`. Inject for deterministic testing. */
  now?: Date;
}): PipelineMonthRow[] {
  const { abpReportRows, generatorDetailsRows, systems } = input;
  const now = input.now ?? new Date();
  const isFuture = (d: Date) => d > now;

  type RawBucket = {
    part1Count: number;
    part2Count: number;
    part1KwAc: number;
    part2KwAc: number;
    interconnectedCount: number;
    interconnectedKwAc: number;
  };
  const buckets = new Map<string, RawBucket>();

  const ensureBucket = (month: string): RawBucket => {
    let bucket = buckets.get(month);
    if (!bucket) {
      bucket = {
        part1Count: 0,
        part2Count: 0,
        part1KwAc: 0,
        part2KwAc: 0,
        interconnectedCount: 0,
        interconnectedKwAc: 0,
      };
      buckets.set(month, bucket);
    }
    return bucket;
  };

  // Part 1 + Part 2 from ABP rows, deduped per project key.
  const seenPart1 = new Set<string>();
  const seenPart2 = new Set<string>();
  abpReportRows.forEach((row, index) => {
    const { dedupeKey } = resolvePart2ProjectIdentity(row, index);

    if (!seenPart1.has(dedupeKey)) {
      const submissionDate =
        parseDate(row.Part_1_submission_date) ??
        parseDate(row.Part_1_Submission_Date) ??
        parseDate(row.Part_1_Original_Submission_Date);
      if (submissionDate && !isFuture(submissionDate)) {
        seenPart1.add(dedupeKey);
        const bucket = ensureBucket(monthKey(submissionDate));
        bucket.part1Count += 1;
        const acKw = parseNumber(row.Inverter_Size_kW_AC_Part_1);
        if (acKw !== null) bucket.part1KwAc += acKw;
      }
    }

    if (!seenPart2.has(dedupeKey)) {
      const part2DateRaw =
        clean(row.Part_2_App_Verification_Date) ||
        clean(row.part_2_app_verification_date);
      const verificationDate = parsePart2VerificationDate(part2DateRaw);
      if (verificationDate && !isFuture(verificationDate)) {
        seenPart2.add(dedupeKey);
        const bucket = ensureBucket(monthKey(verificationDate));
        bucket.part2Count += 1;
        const acKw = parseAbpAcSizeKw(row);
        if (acKw !== null) bucket.part2KwAc += acKw;
      }
    }
  });

  // Interconnected from generator-details rows, with installedKwAc fallback.
  const fallbackAcKwByTrackingId = new Map<string, number>();
  for (const system of systems) {
    const trackingId = system.trackingSystemRefId;
    if (!trackingId) continue;
    if (system.installedKwAc === null || system.installedKwAc === undefined) {
      continue;
    }
    if (!fallbackAcKwByTrackingId.has(trackingId)) {
      fallbackAcKwByTrackingId.set(trackingId, system.installedKwAc);
    }
  }

  const seenInterconnectedTrackingIds = new Set<string>();
  for (const row of generatorDetailsRows) {
    const trackingId =
      clean(row["GATS Unit ID"]) ||
      clean(row.gats_unit_id) ||
      clean(row["Unit ID"]) ||
      clean(row.unit_id);
    if (!trackingId || seenInterconnectedTrackingIds.has(trackingId)) {
      continue;
    }

    const onlineDate =
      parseDateOnlineAsMidMonth(
        row["Date Online"] ??
          row["Date online"] ??
          row.date_online ??
          row.date_online_month_year
      ) ??
      parseDate(row.Interconnection_Approval_Date_UTC_Part_2) ??
      parseDate(row.Project_Online_Date_Part_2) ??
      parseDate(row["Date Online"] ?? row.date_online);
    if (!onlineDate || isFuture(onlineDate)) continue;
    seenInterconnectedTrackingIds.add(trackingId);

    const bucket = ensureBucket(monthKey(onlineDate));
    bucket.interconnectedCount += 1;

    const acKw =
      parseGeneratorDetailsAcSizeKw(row) ??
      fallbackAcKwByTrackingId.get(trackingId) ??
      null;
    if (acKw !== null) bucket.interconnectedKwAc += acKw;
  }

  // Build rows with prior-year comparison.
  const rawRows = Array.from(buckets.entries())
    .map(([month, data]) => ({ month, ...data }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const byMonth = new Map(rawRows.map((r) => [r.month, r]));

  return rawRows.map((row) => {
    const [yearStr, monthStr] = row.month.split("-");
    const prevMonth = `${Number(yearStr) - 1}-${monthStr}`;
    const prev = byMonth.get(prevMonth);
    return {
      ...row,
      prevPart1Count: prev?.part1Count ?? 0,
      prevPart2Count: prev?.part2Count ?? 0,
      prevPart1KwAc: prev?.part1KwAc ?? 0,
      prevPart2KwAc: prev?.part2KwAc ?? 0,
      prevInterconnectedCount: prev?.interconnectedCount ?? 0,
      prevInterconnectedKwAc: prev?.interconnectedKwAc ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Pure aggregator — projected monthly cash flow (Part-2-verified rows
// joined to CSG mapping ↦ ICC contract value ↦ contract-scan
// percentages, with optional `localOverrides` applied per CSG ID).
// ---------------------------------------------------------------------------

export function buildPipelineCashFlow(input: {
  part2VerifiedAbpRows: CsvRow[];
  abpCsgSystemMappingRows: CsvRow[];
  abpIccReport3Rows: CsvRow[];
  contractScanResults: readonly PipelineContractScan[];
  overrides: readonly PipelineOverride[];
  /** Defaults to `new Date()`. Inject for deterministic testing. */
  now?: Date;
}): PipelineCashFlowRow[] {
  const {
    part2VerifiedAbpRows,
    abpCsgSystemMappingRows,
    abpIccReport3Rows,
    contractScanResults,
    overrides,
  } = input;
  const now = input.now ?? new Date();

  if (contractScanResults.length === 0) return [];

  const scanByCsgId = new Map<string, PipelineContractScan>();
  for (const r of contractScanResults) scanByCsgId.set(r.csgId, r);

  const overridesByCsgId = new Map<
    string,
    { vfp: number | null | undefined; acp: number | null | undefined }
  >();
  for (const o of overrides) {
    overridesByCsgId.set(o.csgId, { vfp: o.vfp ?? null, acp: o.acp ?? null });
  }

  const csgIdByAppId = new Map<string, string>();
  for (const row of abpCsgSystemMappingRows) {
    const csgId = clean(row.csgId) || clean(row["CSG ID"]);
    const systemId = clean(row.systemId) || clean(row["System ID"]);
    if (csgId && systemId) csgIdByAppId.set(systemId, csgId);
  }

  const iccByAppId = new Map<string, { grossContractValue: number }>();
  for (const row of abpIccReport3Rows) {
    const appId =
      clean(row["Application ID"]) ||
      clean(row.Application_ID) ||
      clean(row.application_id);
    if (!appId) continue;
    const gcv =
      parseNumber(
        row["Total REC Delivery Contract Value"] ||
          row["REC Delivery Contract Value"] ||
          row["Total Contract Value"]
      ) ?? 0;
    const rq =
      parseNumber(
        row["Total Quantity of RECs Contracted"] ||
          row["Contracted SRECs"] ||
          row.SRECs
      ) ?? 0;
    const rp = parseNumber(row["REC Price"]) ?? 0;
    const gross = gcv > 0 ? gcv : rq * rp;
    if (gross > 0) iccByAppId.set(appId, { grossContractValue: gross });
  }

  type CfBucket = {
    vendorFee: number;
    ccAuth: number;
    addlColl: number;
    count: number;
  };
  const byMonth = new Map<string, CfBucket>();

  for (const abpRow of part2VerifiedAbpRows) {
    const appId = clean(abpRow.Application_ID) || clean(abpRow.application_id);
    if (!appId) continue;

    const csgId = csgIdByAppId.get(appId);
    if (!csgId) continue;
    const scan = scanByCsgId.get(csgId);
    const icc = iccByAppId.get(appId);
    if (!scan || !icc) continue;

    const p2Raw =
      clean(abpRow.Part_2_App_Verification_Date) ||
      clean(abpRow.part_2_app_verification_date);
    const p2Date = parsePart2VerificationDate(p2Raw);
    if (!p2Date || p2Date > now) continue;

    const cfDate = new Date(p2Date.getFullYear(), p2Date.getMonth() + 1, 1);
    const cfMonth = monthKey(cfDate);

    const gcv = icc.grossContractValue;
    const localOv = overridesByCsgId.get(csgId);
    const vfp =
      (localOv?.vfp ?? null) ??
      scan.overrideVendorFeePercent ??
      scan.vendorFeePercent ??
      0;
    const vendorFee = roundMoney(gcv * (vfp / 100));
    const ccAuth =
      scan.ccAuthorizationCompleted === false ? roundMoney(gcv * 0.05) : 0;
    const acp =
      (localOv?.acp ?? null) ??
      scan.overrideAdditionalCollateralPercent ??
      scan.additionalCollateralPercent ??
      0;
    const addlColl = roundMoney(gcv * (acp / 100));

    const bucket = byMonth.get(cfMonth) ?? {
      vendorFee: 0,
      ccAuth: 0,
      addlColl: 0,
      count: 0,
    };
    bucket.vendorFee = roundMoney(bucket.vendorFee + vendorFee);
    bucket.ccAuth = roundMoney(bucket.ccAuth + ccAuth);
    bucket.addlColl = roundMoney(bucket.addlColl + addlColl);
    bucket.count += 1;
    byMonth.set(cfMonth, bucket);
  }

  const sortedMonths = Array.from(byMonth.keys()).sort();
  return sortedMonths.map((month) => {
    const b = byMonth.get(month)!;
    const [yearStr, monthStr] = month.split("-");
    const prevMonth = `${Number(yearStr) - 1}-${monthStr}`;
    const pb = byMonth.get(prevMonth);
    return {
      month,
      vendorFee: b.vendorFee,
      ccAuthCollateral: b.ccAuth,
      additionalCollateral: b.addlColl,
      totalCashFlow: roundMoney(b.vendorFee + b.ccAuth + b.addlColl),
      projectCount: b.count,
      prevVendorFee: pb?.vendorFee ?? 0,
      prevCcAuthCollateral: pb?.ccAuth ?? 0,
      prevAdditionalCollateral: pb?.addlColl ?? 0,
      prevTotalCashFlow: pb
        ? roundMoney(pb.vendorFee + pb.ccAuth + pb.addlColl)
        : 0,
      prevProjectCount: pb?.count ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Cached server entrypoint.
// ---------------------------------------------------------------------------

const APP_PIPELINE_DEPS = [
  "abpReport",
  "generatorDetails",
  "abpCsgSystemMapping",
  "abpIccReport3Rows",
] as const;
const ARTIFACT_TYPE = "appPipelineAggregates";

export const APP_PIPELINE_RUNNER_VERSION = "data-flow-pr5_13_apppipeline@1";

/** Stable hash of the overrides payload (sorted by csgId for determinism). */
function hashOverrides(overrides: readonly PipelineOverride[]): string {
  if (overrides.length === 0) return "no-overrides";
  const sorted = [...overrides].sort((a, b) => a.csgId.localeCompare(b.csgId));
  const parts = sorted.map(
    (o) => `${o.csgId}:${o.vfp ?? ""}:${o.acp ?? ""}`
  );
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

async function computeAppPipelineInputHash(input: {
  scopeId: string;
  overrides: readonly PipelineOverride[];
  /** Defaults to `new Date()`. Inject for deterministic testing. */
  now?: Date;
}): Promise<{
  hash: string;
  abpReportBatchId: string | null;
  generatorDetailsBatchId: string | null;
  abpCsgSystemMappingBatchId: string | null;
  abpIccReport3BatchId: string | null;
  snapshotHash: string;
}> {
  const versions = await getActiveVersionsForKeys(
    input.scopeId,
    APP_PIPELINE_DEPS as unknown as string[]
  );
  const abpReportBatchId =
    versions.find((v) => v.datasetKey === "abpReport")?.batchId ?? null;
  const generatorDetailsBatchId =
    versions.find((v) => v.datasetKey === "generatorDetails")?.batchId ?? null;
  const abpCsgSystemMappingBatchId =
    versions.find((v) => v.datasetKey === "abpCsgSystemMapping")?.batchId ??
    null;
  const abpIccReport3BatchId =
    versions.find((v) => v.datasetKey === "abpIccReport3Rows")?.batchId ?? null;

  const snapshotHash = await computeSystemSnapshotHash(input.scopeId);

  // The cash-flow aggregator's `isFuture` check depends on "today",
  // so include a UTC day bucket. Without it, an aggregate computed
  // late on day N could silently include "yesterday's future months"
  // when read on day N+1.
  const now = input.now ?? new Date();
  const dayBucket = toDateKey(now, "UTC");

  const overridesHash = hashOverrides(input.overrides);

  const hash = createHash("sha256")
    .update(
      [
        `abp:${abpReportBatchId ?? ""}`,
        `generator:${generatorDetailsBatchId ?? ""}`,
        `mapping:${abpCsgSystemMappingBatchId ?? ""}`,
        `icc:${abpIccReport3BatchId ?? ""}`,
        `snapshot:${snapshotHash}`,
        `day:${dayBucket}`,
        `overrides:${overridesHash}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return {
    hash,
    abpReportBatchId,
    generatorDetailsBatchId,
    abpCsgSystemMappingBatchId,
    abpIccReport3BatchId,
    snapshotHash,
  };
}

export type AppPipelineAggregates = {
  monthlyRows: PipelineMonthRow[];
  cashFlowRows: PipelineCashFlowRow[];
};

/**
 * Public entrypoint for the tRPC query. Runs both pure aggregators
 * server-side and caches the combined result in
 * `solarRecComputedArtifacts`. `overrides` is hashed into the cache
 * key so per-user override changes recompute cleanly without bleeding
 * into other sessions' cached results.
 *
 * `jsonSerde` because every output field is a number/string (no Date
 * fields round-trip — the aggregators emit "YYYY-MM" strings).
 */
export async function getOrBuildAppPipelineAggregates(
  scopeId: string,
  overrides: readonly PipelineOverride[]
): Promise<{
  result: AppPipelineAggregates;
  fromCache: boolean;
}> {
  const {
    hash,
    abpReportBatchId,
    generatorDetailsBatchId,
    abpCsgSystemMappingBatchId,
    abpIccReport3BatchId,
  } = await computeAppPipelineInputHash({ scopeId, overrides });

  // No abpReport active batch → no Part 1/2 rows possible → both
  // monthly counts and cash flow are empty. Skip the snapshot build
  // and the per-dataset row loads entirely.
  if (!abpReportBatchId) {
    return {
      result: { monthlyRows: [], cashFlowRows: [] },
      fromCache: false,
    };
  }

  const { result, fromCache } = await withArtifactCache<AppPipelineAggregates>({
    scopeId,
    artifactType: ARTIFACT_TYPE,
    inputVersionHash: hash,
    serde: jsonSerde<AppPipelineAggregates>(),
    rowCount: (out) => out.monthlyRows.length + out.cashFlowRows.length,
    recompute: async () => {
      const [
        snapshot,
        abpReportRows,
        generatorDetailsRows,
        abpCsgSystemMappingRows,
        abpIccReport3Rows,
      ] = await Promise.all([
        getOrBuildSystemSnapshot(scopeId),
        loadDatasetRows(scopeId, abpReportBatchId, srDsAbpReport),
        loadDatasetRows(
          scopeId,
          generatorDetailsBatchId,
          srDsGeneratorDetails
        ),
        loadDatasetRows(
          scopeId,
          abpCsgSystemMappingBatchId,
          srDsAbpCsgSystemMapping
        ),
        loadDatasetRows(scopeId, abpIccReport3BatchId, srDsAbpIccReport3Rows),
      ]);

      const systems = extractSnapshotSystemsForPipeline(snapshot.systems);

      const monthlyRows = buildPipelineMonthly({
        abpReportRows,
        generatorDetailsRows,
        systems,
      });

      // Cash flow needs the Part-2-verified subset of abpReport rows
      // and contract-scan results for every CSG ID referenced by the
      // mapping. Filter + load both inside the recompute path so the
      // cache fully hydrates the aggregator inputs without any
      // upstream parent dependency.
      const part2VerifiedAbpRows = abpReportRows.filter(isPart2VerifiedAbpRow);
      const csgIds = new Set<string>();
      for (const row of abpCsgSystemMappingRows) {
        const csgId = clean(row.csgId) || clean(row["CSG ID"]);
        if (csgId) csgIds.add(csgId);
      }
      const scanRows =
        csgIds.size > 0
          ? await getLatestScanResultsByCsgIds(scopeId, Array.from(csgIds))
          : [];
      const contractScanResults: PipelineContractScan[] = scanRows.map(
        (r) => ({
          csgId: r.csgId,
          vendorFeePercent: r.vendorFeePercent ?? null,
          overrideVendorFeePercent: r.overrideVendorFeePercent ?? null,
          additionalCollateralPercent: r.additionalCollateralPercent ?? null,
          overrideAdditionalCollateralPercent:
            r.overrideAdditionalCollateralPercent ?? null,
          ccAuthorizationCompleted: r.ccAuthorizationCompleted ?? null,
        })
      );

      const cashFlowRows = buildPipelineCashFlow({
        part2VerifiedAbpRows,
        abpCsgSystemMappingRows,
        abpIccReport3Rows,
        contractScanResults,
        overrides,
      });

      return { monthlyRows, cashFlowRows };
    },
  });

  return { result, fromCache };
}

// ---------------------------------------------------------------------------
// Snapshot extraction — the pipeline aggregator needs `installedKwAc`
// (for the interconnected-bucket fallback) which the canonical
// `extractSnapshotSystems` doesn't surface. Locally extend the
// extractor here rather than churn the shared helper.
// ---------------------------------------------------------------------------

function extractSnapshotSystemsForPipeline(
  systems: readonly unknown[]
): PipelineSnapshotSystem[] {
  const base = extractSnapshotSystems(systems);
  // Re-merge `installedKwAc` from the original payload by index. The
  // base extractor already filters non-objects, so its length / order
  // matches a parallel iteration over `systems` skipping the same
  // entries.
  const out: PipelineSnapshotSystem[] = [];
  let baseIdx = 0;
  for (const entry of systems) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const installedKwAc =
      typeof r.installedKwAc === "number" ? r.installedKwAc : null;
    out.push({ ...base[baseIdx]!, installedKwAc });
    baseIdx += 1;
  }
  return out;
}
