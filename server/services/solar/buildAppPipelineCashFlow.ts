/**
 * Server-side Application Pipeline cash-flow aggregator.
 *
 * Task 5.13 PR-5 (2026-04-27) — moves
 * `client/src/solar-rec-dashboard/components/AppPipelineTab.tsx ::
 * pipelineCashFlowRows` onto the server. The cash-flow projection
 * walks ABP Part-2 rows + CSG system mapping + ICC contract values +
 * contract scan results to bucket monthly vendor-fee / CC-auth /
 * additional-collateral exposure. Cash-flow month is Part-2
 * verification month + 1.
 *
 * Per-csgId vendor-fee % and additional-collateral % can be
 * overridden client-side via the Financials tab's `localOverrides`
 * Map. Those overrides are user-editable per-session state that's
 * not persisted server-side, so the query takes them as input —
 * the cache key includes a serialized hash of the overrides, which
 * means recompute fires only when the user changes an override or
 * when the underlying contract scan / batch data changes.
 *
 * Cache hits are common because the typical user never enters
 * overrides (defaults from scan results are used). When overrides
 * exist, they tend to be stable across renders — re-fetching the
 * tab returns the same hash.
 */

import { createHash } from "node:crypto";
import {
  srDsAbpCsgSystemMapping,
  srDsAbpIccReport3Rows,
  srDsAbpReport,
} from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import { getLatestScanResultsByCsgIds } from "../../db/contractScans";
import {
  type CsvRow,
  clean,
  isPart2VerifiedAbpRow,
  parseNumber,
  parsePart2VerificationDate,
  roundMoney,
} from "./aggregatorHelpers";
import { loadDatasetRows } from "./buildSystemSnapshot";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-csgId override layer the client passes through. */
export type CashFlowOverrideMap = Record<string, { vfp: number; acp: number }>;

/** Output shape — mirrors `PipelineCashFlowRow` in client state types. */
export type PipelineCashFlowRow = {
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
 * Subset of `contractScanResults` row that the aggregator reads.
 * Defined here as the minimum surface so the test fixture only
 * has to mock these fields, not the full DB row type.
 */
type ContractScanResult = {
  csgId: string;
  vendorFeePercent: number | null;
  overrideVendorFeePercent: number | null;
  additionalCollateralPercent: number | null;
  overrideAdditionalCollateralPercent: number | null;
  ccAuthorizationCompleted: boolean | null;
};

// ---------------------------------------------------------------------------
// Pure aggregator — byte-for-byte mirror of the client useMemo body.
// ---------------------------------------------------------------------------

export function buildAppPipelineCashFlow(input: {
  part2VerifiedAbpRows: CsvRow[];
  abpCsgSystemMappingRows: CsvRow[];
  abpIccReport3Rows: CsvRow[];
  contractScanResults: readonly ContractScanResult[];
  overrides: CashFlowOverrideMap;
  /** Defaults to `new Date()`; injectable for deterministic tests. */
  now?: Date;
}): PipelineCashFlowRow[] {
  const {
    part2VerifiedAbpRows,
    abpCsgSystemMappingRows: mappingRows,
    abpIccReport3Rows: iccRows,
    contractScanResults,
    overrides,
    now = new Date(),
  } = input;

  if (contractScanResults.length === 0) return [];

  // Build lookup maps (mirrors financialProfitData join chain).
  const scanByCsgId = new Map<string, ContractScanResult>();
  for (const r of contractScanResults) scanByCsgId.set(r.csgId, r);

  const csgIdByAppId = new Map<string, string>();
  for (const row of mappingRows) {
    const csgId = (row.csgId || row["CSG ID"] || "").trim();
    const systemId = (row.systemId || row["System ID"] || "").trim();
    if (csgId && systemId) csgIdByAppId.set(systemId, csgId);
  }

  const iccByAppId = new Map<string, { grossContractValue: number }>();
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
    if (gross > 0) iccByAppId.set(appId, { grossContractValue: gross });
  }

  // Aggregate into monthly buckets keyed on cash-flow month
  // (Part-2 verification month + 1).
  type CfBucket = {
    vendorFee: number;
    ccAuth: number;
    addlColl: number;
    count: number;
  };
  const byMonth = new Map<string, CfBucket>();

  for (const abpRow of part2VerifiedAbpRows) {
    const appId = (abpRow.Application_ID || abpRow.application_id || "").trim();
    if (!appId) continue;

    const csgId = csgIdByAppId.get(appId);
    if (!csgId) continue;
    const scan = scanByCsgId.get(csgId);
    const icc = iccByAppId.get(appId);
    if (!scan || !icc) continue;

    const p2Raw =
      abpRow.Part_2_App_Verification_Date ||
      abpRow.part_2_app_verification_date ||
      "";
    const p2Date = parsePart2VerificationDate(p2Raw);
    if (!p2Date || p2Date > now) continue;

    const cfDate = new Date(p2Date.getFullYear(), p2Date.getMonth() + 1, 1);
    const cfMonth = `${cfDate.getFullYear()}-${String(
      cfDate.getMonth() + 1
    ).padStart(2, "0")}`;

    const gcv = icc.grossContractValue;
    const localOv = overrides[csgId];
    const vfp =
      localOv?.vfp ?? scan.overrideVendorFeePercent ?? scan.vendorFeePercent ?? 0;
    const vendorFee = roundMoney(gcv * (vfp / 100));
    const ccAuth =
      scan.ccAuthorizationCompleted === false ? roundMoney(gcv * 0.05) : 0;
    const acp =
      localOv?.acp ??
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

  // Build rows + prior-year comparison.
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

const APP_PIPELINE_CASH_FLOW_DEPS = [
  "abpReport",
  "abpCsgSystemMapping",
  "abpIccReport3Rows",
] as const;
const ARTIFACT_TYPE = "appPipelineCashFlow";

export const APP_PIPELINE_CASH_FLOW_RUNNER_VERSION =
  "data-flow-pr5_13_apppipelinecashflow@1";

/**
 * Stable hash of the override map. Order-independent — sorts by
 * csgId before serializing — so re-renders with the same logical
 * overrides produce the same hash.
 */
function hashOverrideMap(overrides: CashFlowOverrideMap): string {
  const keys = Object.keys(overrides).sort();
  if (keys.length === 0) return "none";
  const serialized = keys
    .map((k) => `${k}=${overrides[k].vfp},${overrides[k].acp}`)
    .join("|");
  return createHash("sha256")
    .update(serialized)
    .digest("hex")
    .slice(0, 16);
}

async function computeAppPipelineCashFlowInputHash(
  scopeId: string,
  overrides: CashFlowOverrideMap
): Promise<{
  hash: string;
  abpReportBatchId: string | null;
  mappingBatchId: string | null;
  iccBatchId: string | null;
}> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    APP_PIPELINE_CASH_FLOW_DEPS as unknown as string[]
  );
  const abpReportBatchId =
    versions.find((v) => v.datasetKey === "abpReport")?.batchId ?? null;
  const mappingBatchId =
    versions.find((v) => v.datasetKey === "abpCsgSystemMapping")?.batchId ??
    null;
  const iccBatchId =
    versions.find((v) => v.datasetKey === "abpIccReport3Rows")?.batchId ??
    null;

  const overrideHash = hashOverrideMap(overrides);

  const hash = createHash("sha256")
    .update(
      [
        `abp:${abpReportBatchId ?? ""}`,
        `mapping:${mappingBatchId ?? ""}`,
        `icc:${iccBatchId ?? ""}`,
        `overrides:${overrideHash}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return { hash, abpReportBatchId, mappingBatchId, iccBatchId };
}

export async function getOrBuildAppPipelineCashFlow(
  scopeId: string,
  overrides: CashFlowOverrideMap = {}
): Promise<{ rows: PipelineCashFlowRow[]; fromCache: boolean }> {
  const { hash, abpReportBatchId, mappingBatchId, iccBatchId } =
    await computeAppPipelineCashFlowInputHash(scopeId, overrides);

  // Without ABP, mapping, AND ICC data the join chain produces zero
  // rows — return empty without doing the (expensive) load. The
  // client renders the same empty state.
  if (!abpReportBatchId || !mappingBatchId || !iccBatchId) {
    return { rows: [], fromCache: false };
  }

  const { result, fromCache } = await withArtifactCache<PipelineCashFlowRow[]>({
    scopeId,
    artifactType: ARTIFACT_TYPE,
    inputVersionHash: hash,
    serde: jsonSerde<PipelineCashFlowRow[]>(),
    rowCount: (rows) => rows.length,
    recompute: async () => {
      const [abpReportRows, mappingRows, iccRows] = await Promise.all([
        loadDatasetRows(scopeId, abpReportBatchId, srDsAbpReport),
        loadDatasetRows(
          scopeId,
          mappingBatchId,
          srDsAbpCsgSystemMapping
        ),
        loadDatasetRows(scopeId, iccBatchId, srDsAbpIccReport3Rows),
      ]);

      // Filter Part-2 verified rows server-side (mirrors the
      // parent's `part2VerifiedAbpRows` useMemo).
      const part2VerifiedAbpRows = abpReportRows.filter(isPart2VerifiedAbpRow);

      // Pull contract scan results for every csgId we've mapped.
      // The mapping rows' csgIds are the only ones the cash flow
      // formula uses; loading scans for csgIds that aren't in the
      // mapping is wasted work.
      const csgIdsForScanLookup = new Set<string>();
      for (const row of mappingRows) {
        const csgId = (row.csgId || row["CSG ID"] || "").trim();
        if (csgId) csgIdsForScanLookup.add(csgId);
      }
      const contractScanResults =
        csgIdsForScanLookup.size === 0
          ? []
          : await getLatestScanResultsByCsgIds(
              scopeId,
              Array.from(csgIdsForScanLookup)
            );

      return buildAppPipelineCashFlow({
        part2VerifiedAbpRows,
        abpCsgSystemMappingRows: mappingRows,
        abpIccReport3Rows: iccRows,
        contractScanResults: contractScanResults as unknown as ContractScanResult[],
        overrides,
      });
    },
  });

  return { rows: result, fromCache };
}
