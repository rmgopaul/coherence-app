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
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import {
  clean,
  isPart2VerifiedAbpRow,
  parseNumber,
  roundMoney,
  type CsvRow,
} from "./aggregatorHelpers";
import { loadDatasetRows } from "./buildSystemSnapshot";
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
    const hasOverride =
      scan.overrideVendorFeePercent != null ||
      scan.overrideAdditionalCollateralPercent != null ||
      scan.overriddenAt != null;
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

export const FINANCIALS_RUNNER_VERSION = "phase-5d-pr3-financials@1";

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

export async function getOrBuildFinancialsAggregates(
  scopeId: string
): Promise<FinancialsAggregates & { fromCache: boolean }> {
  const batchIds = await resolveFinancialsBatchIds(scopeId);

  if (
    !batchIds.abpCsgSystemMappingBatchId ||
    !batchIds.abpIccReport3RowsBatchId ||
    !batchIds.abpReportBatchId
  ) {
    return {
      ...EMPTY_FINANCIALS,
      fromCache: false,
    };
  }

  const mappingRows = await loadDatasetRows(
    scopeId,
    batchIds.abpCsgSystemMappingBatchId,
    srDsAbpCsgSystemMapping
  );
  const financialCsgIds = buildFinancialCsgIds(mappingRows);

  if (financialCsgIds.length === 0) {
    return {
      ...EMPTY_FINANCIALS,
      fromCache: false,
    };
  }

  const scanResults = await getLatestScanResultsByCsgIds(
    scopeId,
    financialCsgIds
  );

  if (scanResults.length === 0) {
    return {
      ...EMPTY_FINANCIALS,
      fromCache: false,
    };
  }

  const scanResultsHash = computeScanResultsHash(scanResults);
  const inputVersionHash = computeFinancialsInputHash(
    batchIds,
    scanResultsHash
  );

  const { result, fromCache } = await withArtifactCache<FinancialsAggregates>({
    scopeId,
    artifactType: FINANCIALS_ARTIFACT_TYPE,
    inputVersionHash,
    serde: jsonSerde<FinancialsAggregates>(),
    rowCount: data => data.rows.length,
    recompute: async () => {
      const [iccRows, abpRows] = await Promise.all([
        loadDatasetRows(
          scopeId,
          batchIds.abpIccReport3RowsBatchId,
          srDsAbpIccReport3Rows
        ),
        loadDatasetRows(scopeId, batchIds.abpReportBatchId, srDsAbpReport),
      ]);

      return buildFinancialsAggregates({
        mappingRows,
        iccRows,
        abpRows,
        scanResults,
      });
    },
  });

  return { ...result, fromCache };
}
