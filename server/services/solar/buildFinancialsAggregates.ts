/**
 * Server-side aggregator for the Financials tab.
 *
 * Phase 5d PR 3 (2026-04-29) — replaces the parent dashboard's
 * `financialProfitData` useMemo in
 * `client/src/features/solar-rec/SolarRecDashboard.tsx`.
 *
 * The pure aggregator below mirrors that useMemo's ABP ↔ CSG mapping,
 * ICC Report 3, ABP report, and contract-scan join. The cached entrypoint
 * also includes a contract-scan freshness hash because manual override
 * edits mutate the scan rows without changing any dashboard dataset batch
 * ID.
 */

import { createHash } from "node:crypto";
import {
  srDsAbpCsgSystemMapping,
  srDsAbpIccReport3Rows,
  srDsAbpReport,
} from "../../../drizzle/schemas/solar";
import { getLatestScanResultsByCsgIds } from "../../db";
import {
  getActiveVersionsForKeys,
  getComputedArtifact,
  upsertComputedArtifact,
} from "../../db/solarRecDatasets";
import {
  clean,
  isPart2VerifiedAbpRow,
  parseNumber,
  roundMoney,
  type CsvRow,
} from "./aggregatorHelpers";
import { loadDatasetRows } from "./buildSystemSnapshot";
import { computeFinancialsHash } from "./financialsVersion";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

export type FinancialsProfitRow = {
  systemName: string;
  applicationId: string;
  csgId: string;
  grossContractValue: number;
  vendorFeePercent: number;
  vendorFeeAmount: number;
  utilityCollateral: number;
  additionalCollateralPercent: number;
  additionalCollateralAmount: number;
  ccAuth5Percent: number;
  applicationFee: number;
  totalDeductions: number;
  profit: number;
  totalCollateralization: number;
  needsReview: boolean;
  reviewReason: string;
  hasOverride: boolean;
};

export type FinancialsAggregates = {
  rows: FinancialsProfitRow[];
  totalProfit: number;
  avgProfit: number;
  totalCollateralization: number;
  totalUtilityCollateral: number;
  totalAdditionalCollateral: number;
  totalCcAuth: number;
  systemsWithData: number;
};

/**
 * Debug shape consumed by FinancialsTab's diagnostic panel. Mirrors
 * the prior client-side `financialProfitDebug` useMemo (which read
 * `datasets.abpCsgSystemMapping.rows` + `datasets.abpIccReport3Rows
 * .rows` + `part2VerifiedAbpRows`). The dynamic React Query state
 * fields (`queryStatus`, `queryFetching`, `queryEnabled`,
 * `queryErrorMessage`) stay client-side; the static data here joins
 * with them at render time.
 */
export type FinancialsDebugAggregate = {
  counts: {
    part2VerifiedAbpRows: number;
    mappingRows: number;
    iccReport3Rows: number;
    financialCsgIdsCount: number;
    scanResultsReturned: number;
  };
  chain: {
    iterated: number;
    withAppId: number;
    withCsgId: number;
    withScan: number;
    withIcc: number;
    final: number;
  };
  samples: {
    mappingCsgIds: string[];
    scanCsgIds: string[];
    mappingAppIds: string[];
    iccAppIds: string[];
    part2AppIds: string[];
  };
  icc: {
    headers: string[];
    appIdFieldFound: string[];
    contractValueFieldFound: string[];
  };
};

type FinancialsContractScanRow = {
  id?: string | null;
  csgId: string;
  systemName?: string | null;
  vendorFeePercent?: number | null;
  overrideVendorFeePercent?: number | null;
  additionalCollateralPercent?: number | null;
  overrideAdditionalCollateralPercent?: number | null;
  ccAuthorizationCompleted?: boolean | null;
  acSizeKw?: number | null;
  scannedAt?: Date | string | null;
  overriddenAt?: Date | string | null;
};

export type FinancialsAggregatorInput = {
  mappingRows: CsvRow[];
  iccRows: CsvRow[];
  abpRows: CsvRow[];
  scanResults: FinancialsContractScanRow[];
};

const EMPTY_FINANCIALS: FinancialsAggregates = {
  rows: [],
  totalProfit: 0,
  avgProfit: 0,
  totalCollateralization: 0,
  totalUtilityCollateral: 0,
  totalAdditionalCollateral: 0,
  totalCcAuth: 0,
  systemsWithData: 0,
};

export const EMPTY_FINANCIALS_DEBUG: FinancialsDebugAggregate = {
  counts: {
    part2VerifiedAbpRows: 0,
    mappingRows: 0,
    iccReport3Rows: 0,
    financialCsgIdsCount: 0,
    scanResultsReturned: 0,
  },
  chain: {
    iterated: 0,
    withAppId: 0,
    withCsgId: 0,
    withScan: 0,
    withIcc: 0,
    final: 0,
  },
  samples: {
    mappingCsgIds: [],
    scanCsgIds: [],
    mappingAppIds: [],
    iccAppIds: [],
    part2AppIds: [],
  },
  icc: {
    headers: [],
    appIdFieldFound: [],
    contractValueFieldFound: [],
  },
};

/**
 * Pure builder for the FinancialsTab debug panel's static fields.
 * Matches the per-step join logic the client memo previously ran
 * over hydrated `datasets[k].rows` arrays. The 4 dynamic
 * React-Query fields (`queryStatus`, `queryFetching`,
 * `queryEnabled`, `queryErrorMessage`) are not represented here —
 * the client composes them on top of this static shape.
 */
export function buildFinancialsDebug(input: {
  mappingRows: CsvRow[];
  iccRows: CsvRow[];
  abpRows: CsvRow[];
  scanResults: FinancialsContractScanRow[];
  financialCsgIds: string[];
}): FinancialsDebugAggregate {
  const { mappingRows, iccRows, abpRows, scanResults, financialCsgIds } = input;

  // Step 1: parse the mapping into both directions
  const csgIdByAppId = new Map<string, string>();
  const appIdByCsgId = new Map<string, string>();
  for (const row of mappingRows) {
    const csgId = clean(row.csgId || row["CSG ID"]);
    const systemId = clean(row.systemId || row["System ID"]);
    if (csgId && systemId) {
      csgIdByAppId.set(systemId, csgId);
      appIdByCsgId.set(csgId, systemId);
    }
  }

  // Step 2: scan-by-csgId
  const scanByCsgId = new Map<string, FinancialsContractScanRow>();
  for (const r of scanResults) {
    scanByCsgId.set(r.csgId, r);
  }

  // Step 3: ICC by appId — same field-name fallbacks + parseNumber
  // (not parseFloat, which chokes on "$1,234.56").
  const iccAppIds = new Set<string>();
  for (const row of iccRows) {
    const appId = clean(
      row["Application ID"] || row.Application_ID || row.application_id
    );
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
    if (gross > 0) iccAppIds.add(appId);
  }

  // Step 4: walk the join chain on part2VerifiedAbpRows and count
  // attrition at every step.
  const part2VerifiedAbpRows = abpRows.filter((row) =>
    isPart2VerifiedAbpRow(row)
  );
  let withAppId = 0;
  let withCsgId = 0;
  let withScan = 0;
  let withIcc = 0;
  let final = 0;
  for (const abpRow of part2VerifiedAbpRows) {
    const appId = clean(abpRow.Application_ID || abpRow.application_id);
    if (!appId) continue;
    withAppId += 1;

    const csgId = csgIdByAppId.get(appId);
    if (!csgId) continue;
    withCsgId += 1;

    if (scanByCsgId.has(csgId)) {
      withScan += 1;
    }
    if (iccAppIds.has(appId)) {
      withIcc += 1;
    }
    if (scanByCsgId.has(csgId) && iccAppIds.has(appId)) {
      final += 1;
    }
  }

  // Sample IDs from each side for the user to eyeball mismatches.
  const sampleArr = <T>(arr: T[], n: number): T[] => arr.slice(0, n);
  const mappingCsgIdSamples = sampleArr(Array.from(appIdByCsgId.keys()), 5);
  const scanCsgIdSamples = sampleArr(scanResults.map((r) => r.csgId), 5);
  const mappingAppIdSamples = sampleArr(Array.from(csgIdByAppId.keys()), 5);
  const iccAppIdSamples = sampleArr(Array.from(iccAppIds), 5);
  const part2AppIdSamples = sampleArr(
    part2VerifiedAbpRows
      .map((r) => clean(r.Application_ID || r.application_id))
      .filter((id) => id.length > 0),
    5
  );

  // ICC headers: derive from the first row's keys (the typed
  // schema doesn't preserve original CSV headers, but the
  // reconstructed CsvRow keys are equivalent for diagnostics).
  const iccFirstRow = iccRows.length > 0 ? iccRows[0] : null;
  const iccHeaders = iccFirstRow ? Object.keys(iccFirstRow) : [];
  const iccAppIdFieldFound = iccFirstRow
    ? ["Application ID", "Application_ID", "application_id"].filter(
        (key) => key in iccFirstRow && clean(iccFirstRow[key]).length > 0
      )
    : [];
  const iccContractValueFieldFound = iccFirstRow
    ? [
        "Total REC Delivery Contract Value",
        "REC Delivery Contract Value",
        "Total Contract Value",
      ].filter(
        (key) => key in iccFirstRow && clean(iccFirstRow[key]).length > 0
      )
    : [];

  return {
    counts: {
      part2VerifiedAbpRows: part2VerifiedAbpRows.length,
      mappingRows: mappingRows.length,
      iccReport3Rows: iccRows.length,
      financialCsgIdsCount: financialCsgIds.length,
      scanResultsReturned: scanResults.length,
    },
    chain: {
      iterated: part2VerifiedAbpRows.length,
      withAppId,
      withCsgId,
      withScan,
      withIcc,
      final,
    },
    samples: {
      mappingCsgIds: mappingCsgIdSamples,
      scanCsgIds: scanCsgIdSamples,
      mappingAppIds: mappingAppIdSamples,
      iccAppIds: iccAppIdSamples,
      part2AppIds: part2AppIdSamples,
    },
    icc: {
      headers: iccHeaders.slice(0, 20),
      appIdFieldFound: iccAppIdFieldFound,
      contractValueFieldFound: iccContractValueFieldFound,
    },
  };
}

export function buildFinancialsAggregates(
  input: FinancialsAggregatorInput
): FinancialsAggregates {
  const { mappingRows, iccRows, abpRows, scanResults } = input;

  if (scanResults.length === 0) return EMPTY_FINANCIALS;

  // Build lookup maps
  const scanByCsgId = new Map<string, FinancialsContractScanRow>();
  for (const r of scanResults) {
    scanByCsgId.set(r.csgId, r);
  }

  const csgIdByAppId = new Map<string, string>();
  const appIdByCsgId = new Map<string, string>();
  for (const row of mappingRows) {
    const csgId = (row.csgId || row["CSG ID"] || "").trim();
    const systemId = (row.systemId || row["System ID"] || "").trim();
    if (csgId && systemId) {
      csgIdByAppId.set(systemId, csgId);
      appIdByCsgId.set(csgId, systemId);
    }
  }

  // Build ICC Report 3 lookup by applicationId -> grossContractValue
  const iccByAppId = new Map<
    string,
    { grossContractValue: number; recQuantity: number; recPrice: number }
  >();
  for (const row of iccRows) {
    const appId = (
      row["Application ID"] ||
      row.Application_ID ||
      row.application_id ||
      ""
    ).trim();
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
    if (gross > 0) {
      iccByAppId.set(appId, {
        grossContractValue: gross,
        recQuantity: rq,
        recPrice: rp,
      });
    }
  }

  // Build Part I submit date lookup from ABP report rows
  const part1DateByAppId = new Map<string, Date>();
  for (const row of abpRows) {
    const appId = (row.Application_ID || row.application_id || "").trim();
    if (!appId) continue;
    const raw =
      row.Part_1_Submission_Date ||
      row.Part_1_submission_date ||
      row.Part_1_Original_Submission_Date ||
      "";
    if (raw) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) part1DateByAppId.set(appId, d);
    }
  }

  const profitRows: FinancialsProfitRow[] = [];
  const APPLICATION_FEE_CUTOFF = new Date("2024-06-01");
  const part2VerifiedAbpRows = abpRows.filter(row =>
    isPart2VerifiedAbpRow(row)
  );

  for (const abpRow of part2VerifiedAbpRows) {
    const appId = (abpRow.Application_ID || abpRow.application_id || "").trim();
    if (!appId) continue;

    const csgId = csgIdByAppId.get(appId);
    if (!csgId) continue;

    const scan = scanByCsgId.get(csgId);
    const icc = iccByAppId.get(appId);
    if (!scan || !icc) continue;

    const gcv = icc.grossContractValue;
    // hasOverride: align with the client's per-row check
    // (`localOv != null || scan.overriddenAt != null`). The server
    // doesn't have access to `localOverrides` (client-only
    // optimistic-update Map), so it sets `hasOverride` purely from
    // `scan.overriddenAt`. The client wrapper at
    // SolarRecDashboard.tsx ~L5915 OR's local-overrides on top
    // (`hasOverride: true` for any row with a localOv applied), so
    // the final UI value matches the original client-only memo.
    //
    // Pre-cleanup the server also checked
    // `overrideVendorFeePercent`/`overrideAdditionalCollateralPercent`
    // for non-null which marked rows as overridden even when
    // `overriddenAt` wasn't set — a tiny semantic divergence
    // closed here.
    const hasOverride = scan.overriddenAt != null;
    const vfp = scan.overrideVendorFeePercent ?? scan.vendorFeePercent ?? 0;
    const vendorFeeAmount = roundMoney(gcv * (vfp / 100));
    const utilityCollateral = roundMoney(gcv * 0.05);
    const acp =
      scan.overrideAdditionalCollateralPercent ??
      scan.additionalCollateralPercent ??
      0;
    const additionalCollateralAmount = roundMoney(gcv * (acp / 100));

    // CC auth 5%: if CC auth not completed AND not absent from contract,
    // apply 5%
    const ccAuthCompleted = scan.ccAuthorizationCompleted;
    const ccAuth5Percent =
      ccAuthCompleted === false ? roundMoney(gcv * 0.05) : 0;

    // Application fee
    const acSizeKw = scan.acSizeKw ?? 0;
    const part1Date = part1DateByAppId.get(appId);
    let applicationFee = 0;
    if (part1Date && acSizeKw > 0) {
      if (part1Date < APPLICATION_FEE_CUTOFF) {
        applicationFee = Math.min(roundMoney(10 * acSizeKw), 5000);
      } else {
        applicationFee = Math.min(roundMoney(20 * acSizeKw), 15000);
      }
    }

    const totalDeductions = roundMoney(
      vendorFeeAmount +
        utilityCollateral +
        additionalCollateralAmount +
        ccAuth5Percent +
        applicationFee
    );
    // 2026-04-12: profit = vendor fee (what Carbon Solutions earns),
    // NOT gross minus all deductions. The vendor fee is the revenue;
    // the rest (collateral, app fees) are borne by the project.
    const profit = vendorFeeAmount;
    const totalCollateralization = roundMoney(
      utilityCollateral + additionalCollateralAmount + ccAuth5Percent
    );

    // Validation: flag rows where collateral > 30% of GCV.
    const collateralPercent = gcv > 0 ? totalCollateralization / gcv : 0;
    const needsReview = collateralPercent > 0.3;
    const reviewReason = needsReview
      ? `Collateral is ${(collateralPercent * 100).toFixed(1)}% of GCV`
      : "";

    profitRows.push({
      systemName: scan.systemName ?? appId,
      applicationId: appId,
      csgId,
      grossContractValue: gcv,
      vendorFeePercent: vfp,
      vendorFeeAmount,
      utilityCollateral,
      additionalCollateralPercent: acp,
      additionalCollateralAmount,
      ccAuth5Percent,
      applicationFee,
      totalDeductions,
      profit,
      totalCollateralization,
      needsReview,
      reviewReason,
      hasOverride,
    });
  }

  const totalProfit = profitRows.reduce((a, r) => a + r.profit, 0);
  const totalColl = profitRows.reduce(
    (a, r) => a + r.totalCollateralization,
    0
  );
  const totalUtilColl = profitRows.reduce((a, r) => a + r.utilityCollateral, 0);
  const totalAddlColl = profitRows.reduce(
    (a, r) => a + r.additionalCollateralAmount,
    0
  );
  const totalCcAuthColl = profitRows.reduce((a, r) => a + r.ccAuth5Percent, 0);

  return {
    rows: profitRows.sort((a, b) => b.profit - a.profit),
    totalProfit: roundMoney(totalProfit),
    avgProfit:
      profitRows.length > 0 ? roundMoney(totalProfit / profitRows.length) : 0,
    totalCollateralization: roundMoney(totalColl),
    totalUtilityCollateral: roundMoney(totalUtilColl),
    totalAdditionalCollateral: roundMoney(totalAddlColl),
    totalCcAuth: roundMoney(totalCcAuthColl),
    systemsWithData: profitRows.length,
  };
}

const FINANCIALS_DEPS = [
  "abpCsgSystemMapping",
  "abpIccReport3Rows",
  "abpReport",
] as const;

const FINANCIALS_ARTIFACT_TYPE = "financials";

export const FINANCIALS_RUNNER_VERSION =
  // 2026-04-30 (@2): added `csgIds` + `debug` to the response shape
  // for Phase 5e Followup #4 step 4 PR-B. Cache invalidation forces
  // a recompute against the new return type.
  "phase-5e-step4b-financials@2";

type FinancialsBatchIds = {
  abpCsgSystemMappingBatchId: string | null;
  abpIccReport3RowsBatchId: string | null;
  abpReportBatchId: string | null;
};

async function resolveFinancialsBatchIds(
  scopeId: string
): Promise<FinancialsBatchIds> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    FINANCIALS_DEPS as unknown as string[]
  );
  const find = (key: string) =>
    versions.find(v => v.datasetKey === key)?.batchId ?? null;
  return {
    abpCsgSystemMappingBatchId: find("abpCsgSystemMapping"),
    abpIccReport3RowsBatchId: find("abpIccReport3Rows"),
    abpReportBatchId: find("abpReport"),
  };
}

/**
 * PR #337 follow-up item 4 (2026-05-04) — combined batch-ID
 * resolution + canonical financials freshness hash. The slim KPI
 * read path needs both; computing them via separate calls
 * `resolveFinancialsBatchIds` + `computeFinancialsHash` doubled the
 * dataset-versions DB read on every Overview mount.
 *
 * Concurrent execution via `Promise.all` — `computeFinancialsHash`
 * does its own dataset-versions read internally, so this still
 * issues 2 indexed reads in parallel rather than 3 sequential. A
 * future cleanup could also pass `batchIds` into
 * `computeFinancialsHash` directly to drop the second dataset-
 * versions read entirely; deferred since it touches the public
 * `getFinancialsHash` proc's contract.
 */
async function resolveFinancialsBatchIdsAndHash(
  scopeId: string
): Promise<{ batchIds: FinancialsBatchIds; financialsHash: string }> {
  const [batchIds, financialsHash] = await Promise.all([
    resolveFinancialsBatchIds(scopeId),
    computeFinancialsHash(scopeId),
  ]);
  return { batchIds, financialsHash };
}

function buildFinancialCsgIds(mappingRows: CsvRow[]): string[] {
  const ids = new Set<string>();
  for (const row of mappingRows) {
    const csgId = clean(row.csgId || row["CSG ID"]);
    if (csgId) ids.add(csgId);
  }
  return Array.from(ids);
}

function serializeDateLike(value: Date | string | null | undefined): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  return value;
}

function computeScanResultsHash(
  scanResults: FinancialsContractScanRow[]
): string {
  return createHash("sha256")
    .update(
      [...scanResults]
        .sort((a, b) => a.csgId.localeCompare(b.csgId))
        .map(row =>
          [
            row.csgId,
            row.id ?? "",
            row.vendorFeePercent ?? "",
            row.overrideVendorFeePercent ?? "",
            row.additionalCollateralPercent ?? "",
            row.overrideAdditionalCollateralPercent ?? "",
            row.ccAuthorizationCompleted ?? "",
            row.acSizeKw ?? "",
            row.systemName ?? "",
            serializeDateLike(row.scannedAt),
            serializeDateLike(row.overriddenAt),
          ].join(":")
        )
        .join("|")
    )
    .digest("hex")
    .slice(0, 16);
}

function computeFinancialsInputHash(
  batchIds: FinancialsBatchIds,
  scanResultsHash: string
): string {
  return createHash("sha256")
    .update(
      [
        `abpCsgSystemMapping:${batchIds.abpCsgSystemMappingBatchId ?? ""}`,
        `abpIccReport3Rows:${batchIds.abpIccReport3RowsBatchId ?? ""}`,
        `abpReport:${batchIds.abpReportBatchId ?? ""}`,
        `contractScan:${scanResultsHash}`,
        `runner:${FINANCIALS_RUNNER_VERSION}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);
}

export async function getOrBuildFinancialsAggregates(scopeId: string): Promise<
  FinancialsAggregates & {
    csgIds: string[];
    debug: FinancialsDebugAggregate;
    fromCache: boolean;
  }
> {
  // PR #337 follow-up item 4 (2026-05-04) — single helper resolves
  // batch IDs + canonical financials hash in one pass so the slim
  // KPI write path doesn't re-call `resolveFinancialsBatchIds` /
  // `computeFinancialsHash` later. The captured hash also feeds the
  // race-safety recheck inside `writeFinancialsKpiSideCache`.
  const { batchIds, financialsHash: captureKpiHash } =
    await resolveFinancialsBatchIdsAndHash(scopeId);

  // No datasets uploaded at all → nothing to compute on any axis.
  if (
    !batchIds.abpCsgSystemMappingBatchId ||
    !batchIds.abpIccReport3RowsBatchId ||
    !batchIds.abpReportBatchId
  ) {
    return {
      ...EMPTY_FINANCIALS,
      csgIds: [],
      debug: EMPTY_FINANCIALS_DEBUG,
      fromCache: false,
    };
  }

  // Phase 5e step 4 PR-B (2026-04-30) — load mapping + icc + abp
  // up-front so debug counts reflect the user's actual input even
  // when the rows aggregator early-bails on missing csgIds or scan
  // results. Sequential to keep the OOM-safe pattern from #269.
  process.stdout.write(
    `[financialsAggregates] loading mapping/icc/abp for scope=${scopeId}. ` +
      `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`
  );
  const mappingRows = await loadDatasetRows(
    scopeId,
    batchIds.abpCsgSystemMappingBatchId,
    srDsAbpCsgSystemMapping
  );
  const iccRows = await loadDatasetRows(
    scopeId,
    batchIds.abpIccReport3RowsBatchId,
    srDsAbpIccReport3Rows
  );
  const abpRows = await loadDatasetRows(
    scopeId,
    batchIds.abpReportBatchId,
    srDsAbpReport
  );
  process.stdout.write(
    `[financialsAggregates] datasets loaded; ` +
      `mappingRows=${mappingRows.length} iccRows=${iccRows.length} abpRows=${abpRows.length} ` +
      `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB.\n`
  );

  const financialCsgIds = buildFinancialCsgIds(mappingRows);

  // Mapping has no usable CSG IDs — debug is still populated with
  // counts/samples so the user can see WHY the join chain is empty.
  if (financialCsgIds.length === 0) {
    const debug = buildFinancialsDebug({
      mappingRows,
      iccRows,
      abpRows,
      scanResults: [],
      financialCsgIds,
    });
    return {
      ...EMPTY_FINANCIALS,
      csgIds: financialCsgIds,
      debug,
      fromCache: false,
    };
  }

  const scanResults = await getLatestScanResultsByCsgIds(
    scopeId,
    financialCsgIds
  );

  // Always-computed debug now that we know about scan results.
  const debug = buildFinancialsDebug({
    mappingRows,
    iccRows,
    abpRows,
    scanResults,
    financialCsgIds,
  });

  if (scanResults.length === 0) {
    return {
      ...EMPTY_FINANCIALS,
      csgIds: financialCsgIds,
      debug,
      fromCache: false,
    };
  }

  const scanResultsHash = computeScanResultsHash(scanResults);
  const inputVersionHash = computeFinancialsInputHash(
    batchIds,
    scanResultsHash
  );

  // Cache wraps ONLY the heavy rows aggregator. csgIds + debug are
  // cheap to recompute and don't fit the cache key (debug captures
  // a snapshot of the join chain that's deterministic from the
  // already-loaded inputs).
  const { result, fromCache } = await withArtifactCache<FinancialsAggregates>({
    scopeId,
    artifactType: FINANCIALS_ARTIFACT_TYPE,
    inputVersionHash,
    serde: jsonSerde<FinancialsAggregates>(),
    rowCount: (data) => data.rows.length,
    recompute: async () => {
      process.stdout.write(
        `[financialsAggregates] cache miss for scope=${scopeId} — running rows aggregator.\n`
      );
      return buildFinancialsAggregates({
        mappingRows,
        iccRows,
        abpRows,
        scanResults,
      });
    },
  });

  // Side cache: write the 4 Overview KPI sums under the canonical
  // financials freshness hash from `financialsVersion.ts` — the
  // SAME hash inputs the heavy aggregator's invalidation depends on
  // (now includes `abpReport` after PR #337 follow-up item 3).
  //
  // Race-safety (PR #337 follow-up item 2, 2026-05-04). The hash is
  // captured BEFORE the heavy build kicks off (`captureKpiHash`),
  // and re-checked just before the upsert. If a concurrent override
  // edit / fresh scan job / dataset re-upload bumped the freshness
  // signal mid-build, we'd otherwise upsert old totals under the
  // NEW hash and serve them as fresh from the slim Overview path.
  // The pre-write recheck skips with a warning instead.
  await writeFinancialsKpiSideCache(scopeId, captureKpiHash, result).catch(
    (error) => {
      console.warn(
        `[financialsAggregates] kpi side cache write failed for scope=${scopeId}:`,
        error instanceof Error ? error.message : error
      );
    }
  );

  return {
    ...result,
    csgIds: financialCsgIds,
    debug,
    fromCache,
  };
}

// ---------------------------------------------------------------------------
// Slim KPI summary (Overview mount-tier read path)
//
// Returns ONLY the 4 KPI tile values Overview shows on first paint:
//   totalProfit, totalUtilityCollateral, totalAdditionalCollateral,
//   totalCcAuth (+ systemsWithData for the "X systems" subtitle).
//
// The endpoint is CACHE-ONLY. It NEVER triggers a row-materializing
// build — that's the contract for Overview mount per PR #332
// follow-up item 8. The side cache is populated by the heavy
// `getOrBuildFinancialsAggregates` after it runs, so KPIs become
// available the first time any user visits Financials/Pipeline.
//
// Cache-key freshness — PR #334 follow-up item 1 + PR #337
// follow-up items 2 & 3 (2026-05-02 and 2026-05-04). The hash is
// built from `computeFinancialsHash(scopeId)` in
// `financialsVersion.ts` plus the slim runner version. That hash
// binds:
//   - All 9 financial dataset batch IDs (mapping, ICC, ABP, ABP
//     report, etc. — `abpReport` was added to FINANCIALS_CSV_DEPS
//     in PR #337 follow-up item 3 so a re-upload of that single
//     dataset also invalidates the slim cache).
//   - `solarRecScopeContractScanVersion.latestCompletedJobId`
//     (set on every contract-scan job completion).
//   - `solarRecScopeContractScanVersion.latestOverrideAt`
//     (set on every override edit).
// So when an override / fresh scan job / dataset re-upload changes
// the scope's freshness signal, the slim cache lookup misses and
// `getCachedFinancialsKpiSummary` returns `available: false` — the
// Overview tile renders "N/A" instead of stale-true KPIs.
//
// Race-safety (PR #337 follow-up item 2). The heavy aggregator
// captures the hash BEFORE its row build and re-checks it before
// upserting the side-cache row. If a concurrent edit changed the
// freshness signal mid-build, the upsert is skipped — otherwise we
// would write old KPIs under a NEW hash and the slim path would
// serve them as fresh on the next read.
// ---------------------------------------------------------------------------

const FINANCIALS_KPI_SUMMARY_ARTIFACT_TYPE = "financials-kpi-summary";

/**
 * `_runnerVersion` shipped on the slim KPI summary response. Bump
 * when the projected shape changes (additional KPI, type widening,
 * etc.) so cached rows under the old shape are invalidated. Also
 * folded into `computeFinancialsKpiHash` so a runner bump
 * invalidates every persisted side-cache row.
 *
 * v2 (2026-05-02, PR #334 follow-up item 1) — switched the hash
 * inputs from "3 dataset batch IDs" to `computeFinancialsHash` +
 * runner version.
 *
 * v3 (2026-05-04, PR #337 follow-up item 3) — `abpReport` is now
 * inside `computeFinancialsHash`, so the slim hash drops the
 * separate `abpReport` term. Cached v2 rows under the old hash
 * shape are stale.
 */
export const FINANCIALS_KPI_SUMMARY_RUNNER_VERSION =
  "kpi-summary-v3" as const;

export type FinancialsKpiSummary = {
  totalProfit: number;
  totalUtilityCollateral: number;
  totalAdditionalCollateral: number;
  totalCcAuth: number;
  systemsWithData: number;
};

/**
 * Slim KPI cache key. Pure projection of the canonical financials
 * freshness hash + slim runner version — no extra dataset reads
 * once the canonical hash is in hand.
 *
 * Caller MUST already hold the canonical hash from
 * `computeFinancialsHash` (or via `resolveFinancialsBatchIdsAndHash`).
 * Threading the hash through avoids redundant DB reads on the slim
 * read/write paths and is the substrate for the race-safety
 * recheck inside `writeFinancialsKpiSideCache`.
 */
function deriveFinancialsKpiHash(financialsHash: string): string {
  return createHash("sha256")
    .update(
      [
        `runner:${FINANCIALS_KPI_SUMMARY_RUNNER_VERSION}`,
        `financials:${financialsHash}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * Write the slim KPI side-cache row.
 *
 * `capturedFinancialsHash` is the freshness hash sampled BEFORE the
 * heavy build started. We re-sample the current hash and refuse to
 * upsert if it doesn't match — that's the race guard for a
 * concurrent edit landing during the build (override, fresh scan
 * job, dataset re-upload). On mismatch, the heavy aggregator's
 * own cache is also stale, so the next read of either layer will
 * trigger a recompute against the new freshness signal.
 *
 * PR #337 follow-up item 2 (2026-05-04).
 */
export async function writeFinancialsKpiSideCache(
  scopeId: string,
  capturedFinancialsHash: string,
  result: FinancialsAggregates
): Promise<void> {
  const currentFinancialsHash = await computeFinancialsHash(scopeId);
  if (currentFinancialsHash !== capturedFinancialsHash) {
    console.warn(
      `[financialsAggregates] kpi side cache write SKIPPED for scope=${scopeId}: ` +
        `freshness changed mid-build (captured=${capturedFinancialsHash} ` +
        `current=${currentFinancialsHash}). The next heavy build will overwrite.`
    );
    return;
  }
  const hash = deriveFinancialsKpiHash(capturedFinancialsHash);
  const summary: FinancialsKpiSummary = {
    totalProfit: result.totalProfit,
    totalUtilityCollateral: result.totalUtilityCollateral,
    totalAdditionalCollateral: result.totalAdditionalCollateral,
    totalCcAuth: result.totalCcAuth,
    systemsWithData: result.systemsWithData,
  };
  await upsertComputedArtifact({
    scopeId,
    artifactType: FINANCIALS_KPI_SUMMARY_ARTIFACT_TYPE,
    inputVersionHash: hash,
    payload: JSON.stringify(summary),
    rowCount: 0,
  });
}

export type CachedFinancialsKpiSummaryResult =
  | { available: true; kpis: FinancialsKpiSummary }
  | { available: false };

/**
 * Cache-only KPI summary read. Returns `{ available: false }` when
 * either:
 *   - Required dataset batches aren't uploaded (financials can't
 *     be computed at all).
 *   - The current canonical financials hash doesn't match anything
 *     in the side cache. This is the case immediately after an
 *     override edit, a fresh scan job, or a dataset re-upload —
 *     the side cache is keyed on a freshness hash that follows
 *     all three signals.
 *
 * NEVER triggers a row materialization. Single combined DB call
 * (`resolveFinancialsBatchIdsAndHash`) covers both the
 * required-batches early-exit AND the cache-key derivation.
 *
 * Overview tile consumers MUST render an explicit "—" / "N/A"
 * placeholder when `available: false`, not a silent zero.
 */
export async function getCachedFinancialsKpiSummary(
  scopeId: string
): Promise<CachedFinancialsKpiSummaryResult> {
  const { batchIds, financialsHash } =
    await resolveFinancialsBatchIdsAndHash(scopeId);
  if (
    !batchIds.abpCsgSystemMappingBatchId ||
    !batchIds.abpIccReport3RowsBatchId ||
    !batchIds.abpReportBatchId
  ) {
    return { available: false };
  }
  const hash = deriveFinancialsKpiHash(financialsHash);
  const cached = await getComputedArtifact(
    scopeId,
    FINANCIALS_KPI_SUMMARY_ARTIFACT_TYPE,
    hash
  );
  if (!cached) return { available: false };
  try {
    const kpis = JSON.parse(cached.payload) as FinancialsKpiSummary;
    return { available: true, kpis };
  } catch {
    return { available: false };
  }
}
