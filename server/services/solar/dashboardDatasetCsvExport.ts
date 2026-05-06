import {
  srDsAbpCsgPortalDatabaseRows,
  srDsAbpCsgSystemMapping,
  srDsAbpIccReport2Rows,
  srDsAbpIccReport3Rows,
  srDsAbpPortalInvoiceMapRows,
  srDsAbpProjectApplicationRows,
  srDsAbpQuickBooksRows,
  srDsAbpReport,
  srDsAbpUtilityInvoiceRows,
  srDsAccountSolarGeneration,
  srDsAnnualProductionEstimates,
  srDsContractedDate,
  srDsConvertedReads,
  srDsDeliverySchedule,
  srDsGenerationEntry,
  srDsGeneratorDetails,
  srDsSolarApplications,
  srDsTransferHistory,
} from "../../../drizzle/schema";
import { getActiveBatchForDataset } from "../../db";
import { buildCsvText } from "../../routers/helpers/scheduleB";
import { loadDatasetRowsPage } from "./buildSystemSnapshot";

export const DASHBOARD_DATASET_CSV_EXPORT_KEYS = [
  "solarApplications",
  "abpReport",
  "generationEntry",
  "accountSolarGeneration",
  "annualProductionEstimates",
  "abpIccReport2Rows",
  "abpIccReport3Rows",
  "contractedDate",
  "convertedReads",
  "deliveryScheduleBase",
  "transferHistory",
  "generatorDetails",
  "abpCsgSystemMapping",
  "abpProjectApplicationRows",
  "abpPortalInvoiceMapRows",
  "abpCsgPortalDatabaseRows",
  "abpQuickBooksRows",
  "abpUtilityInvoiceRows",
] as const;

export type DashboardDatasetCsvExportKey =
  (typeof DASHBOARD_DATASET_CSV_EXPORT_KEYS)[number];

const DASHBOARD_DATASET_CSV_EXPORT_KEY_SET: ReadonlySet<string> = new Set(
  DASHBOARD_DATASET_CSV_EXPORT_KEYS
);

const TABLES_BY_DATASET_KEY = {
  solarApplications: srDsSolarApplications,
  abpReport: srDsAbpReport,
  generationEntry: srDsGenerationEntry,
  accountSolarGeneration: srDsAccountSolarGeneration,
  annualProductionEstimates: srDsAnnualProductionEstimates,
  abpIccReport2Rows: srDsAbpIccReport2Rows,
  abpIccReport3Rows: srDsAbpIccReport3Rows,
  contractedDate: srDsContractedDate,
  convertedReads: srDsConvertedReads,
  deliveryScheduleBase: srDsDeliverySchedule,
  transferHistory: srDsTransferHistory,
  generatorDetails: srDsGeneratorDetails,
  abpCsgSystemMapping: srDsAbpCsgSystemMapping,
  abpProjectApplicationRows: srDsAbpProjectApplicationRows,
  abpPortalInvoiceMapRows: srDsAbpPortalInvoiceMapRows,
  abpCsgPortalDatabaseRows: srDsAbpCsgPortalDatabaseRows,
  abpQuickBooksRows: srDsAbpQuickBooksRows,
  abpUtilityInvoiceRows: srDsAbpUtilityInvoiceRows,
} as const;

const DATASET_CSV_EXPORT_PAGE_SIZE = 1000;

export interface DatasetCsvExportArtifact {
  csv: string;
  fileName: string;
  rowCount: number;
}

export function isDashboardDatasetCsvExportKey(
  value: unknown
): value is DashboardDatasetCsvExportKey {
  return (
    typeof value === "string" && DASHBOARD_DATASET_CSV_EXPORT_KEY_SET.has(value)
  );
}

export async function buildDatasetCsvExport(
  scopeId: string,
  datasetKey: DashboardDatasetCsvExportKey,
  generatedAtIso: string = new Date().toISOString()
): Promise<DatasetCsvExportArtifact> {
  const activeBatch = await getActiveBatchForDataset(scopeId, datasetKey);
  const fileName = `dataset-${toCsvFileSlug(datasetKey)}-${timestampForCsvFileName(generatedAtIso)}.csv`;
  if (!activeBatch) {
    return { csv: "", fileName, rowCount: 0 };
  }

  const table = TABLES_BY_DATASET_KEY[datasetKey];
  const headerSet = new Set<string>();
  let totalRows = 0;
  let cursor: string | null = null;

  // Pass 1 discovers the complete header set without retaining row
  // pages. This preserves a consistent CSV shape even if a later row
  // has a sparse key that the first page did not contain.
  while (true) {
    const page = await loadDatasetRowsPage(scopeId, activeBatch.id, table, {
      cursor,
      limit: DATASET_CSV_EXPORT_PAGE_SIZE,
    });
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      for (const key of Object.keys(row)) headerSet.add(key);
    }
    totalRows += page.rows.length;
    cursor = page.nextCursor;
    if (cursor === null) break;
  }

  if (totalRows === 0) {
    return { csv: "", fileName, rowCount: 0 };
  }

  const headers = Array.from(headerSet);
  const segments: string[] = [];
  cursor = null;
  while (true) {
    const page = await loadDatasetRowsPage(scopeId, activeBatch.id, table, {
      cursor,
      limit: DATASET_CSV_EXPORT_PAGE_SIZE,
    });
    if (page.rows.length === 0) break;
    const text = buildCsvText(headers, page.rows);
    if (segments.length === 0) {
      segments.push(text);
    } else {
      const newlineIdx = text.indexOf("\n");
      segments.push(newlineIdx >= 0 ? text.slice(newlineIdx + 1) : "");
    }
    cursor = page.nextCursor;
    if (cursor === null) break;
  }

  return {
    csv: segments.join("\n"),
    fileName,
    rowCount: totalRows,
  };
}

function toCsvFileSlug(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function timestampForCsvFileName(iso: string): string {
  return iso.replace(/[^0-9]/g, "").slice(0, 14);
}

export const __TEST_ONLY__ = {
  toCsvFileSlug,
  timestampForCsvFileName,
  DATASET_CSV_EXPORT_PAGE_SIZE,
};
