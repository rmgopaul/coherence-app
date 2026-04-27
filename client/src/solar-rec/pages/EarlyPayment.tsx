import { useAuth } from "@/_core/hooks/useAuth";
import { AskAiPanel } from "@/components/AskAiPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  buildInvoiceNumberToSystemIdMap,
  buildQuickBooksPaidUpfrontLedger,
  buildSettlementCsv,
  computeSettlementRows,
  type ContractTerms,
  type CsgPortalDatabaseRow,
  type CsgSystemIdMappingRow,
  type InvoiceNumberMapRow,
  type PaymentComputationRow,
  type ProjectApplicationLiteRow,
  type QuickBooksInvoice,
  type UtilityInvoiceRow,
} from "@/lib/abpSettlement";
import { parseCsvMatrix, parseTabularFile } from "@/lib/csvParsing";
import {
  clean,
  downloadTextFile,
  formatCurrency,
  formatDateTime,
  formatDuration,
  toErrorMessage,
} from "@/lib/helpers";
// Task 5.10 (2026-04-27): Early Payment migrated to the standalone
// Solar REC app. Every server call (`solarRecDashboard.{getDataset,
// saveDataset}` from Task 5.5; `abpSettlement.{startContractScanJob,
// getJobStatus}` from Task 5.9 PR-A) was already on the standalone
// router; the dual-import compat shim from #133 is collapsed here
// into a single aliased `solarRecTrpc as trpc` so call sites stay
// uniform with the rest of `client/src/solar-rec/pages/`.
import { solarRecTrpc as trpc } from "@/solar-rec/solarRecTrpc";
import { ArrowLeft, Download, ExternalLink, FileSearch, Loader2, Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type LinkedCsvDatasetPayload = {
  fileName: string;
  uploadedAt: string;
  headers: string[];
  csvText: string;
  rows?: Array<Record<string, string>>;
};

type CsgIdImportIssue = {
  csgId: string;
  reason: string;
};

type ContractScanResult = {
  csgId: string;
  fileName: string;
  ccAuthorizationCompleted: boolean | null;
  ccCardAsteriskCount: number | null;
  additionalCollateralPercent: number | null;
  vendorFeePercent: number | null;
  recQuantity: number | null;
  recPrice: number | null;
  paymentMethod: string | null;
  payeeName: string | null;
  mailingAddress1: string | null;
  mailingAddress2: string | null;
  cityStateZip: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  error: string | null;
};

type IccContractRow = {
  applicationId: string;
  recQuantity: number | null;
  recPrice: number | null;
  grossContractValue: number | null;
  utilityName: string | null;
  systemAddressLine1: string;
  systemAddressLine2: string;
  systemCity: string;
  systemState: string;
  systemZip: string;
  sourceLabel: "icc2" | "icc3";
};

const SHARED_DATASET_KEYS = {
  csgSystemMapping: "abpCsgSystemMapping",
  quickBooks: "abpQuickBooksRows",
  projectApplications: "abpProjectApplicationRows",
  portalInvoiceMap: "abpPortalInvoiceMapRows",
  csgPortalDatabase: "abpCsgPortalDatabaseRows",
  iccReport2: "abpIccReport2Rows",
  iccReport3: "abpIccReport3Rows",
} as const;

const DEEP_UPDATE_COMPAT_KEYS = {
  iccReport2: "deep_update_report_iccReport2",
  iccReport3: "deep_update_report_iccReport3",
} as const;

const CSG_ID_STORAGE_KEY = "early_payment_csg_ids_v1";
const CSG_FILE_STORAGE_KEY = "early_payment_csg_file_name_v1";
const ACTIVE_SCAN_JOB_STORAGE_KEY = "early_payment_active_scan_job_id_v1";

function parseNumericCell(value: unknown): number | null {
  const normalized = clean(value).replace(/,/g, "").replace(/[$%]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBooleanText(value: unknown): boolean | null {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "1" ||
    normalized.includes("reimburs") ||
    normalized.includes("returned")
  ) {
    return true;
  }
  if (normalized === "false" || normalized === "no" || normalized === "n" || normalized === "0") {
    return false;
  }
  return null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeAlias(value: string): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getRowValueByAliases(row: Record<string, string>, aliases: string[]): string {
  if (!row || typeof row !== "object") return "";
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const target = normalizeAlias(alias);
    const found = entries.find(([key]) => normalizeAlias(key) === target);
    if (!found) continue;
    const value = clean(found[1]);
    if (value) return value;
  }
  return "";
}

function parseCsgIds(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,;\n\t]+/g)
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

function parseRowsFromCsv(csvText: string, headers: string[]): Array<Record<string, string>> {
  const matrix = parseCsvMatrix(csvText);
  if (matrix.length === 0) return [];

  const firstRow = matrix[0] ?? [];
  const normalizedHeaders = headers.map((header) => clean(header)).filter(Boolean);
  const firstRowMatchesHeaders =
    firstRow.length === normalizedHeaders.length &&
    firstRow.every((value, index) => clean(value) === normalizedHeaders[index]);
  const bodyRows = firstRowMatchesHeaders ? matrix.slice(1) : matrix;

  return bodyRows.map((cells) => {
    const record: Record<string, string> = {};
    normalizedHeaders.forEach((header, index) => {
      record[header] = clean(cells[index]);
    });
    return record;
  });
}

function parseChunkPointerPayload(payload: string): string[] | null {
  try {
    const parsed = JSON.parse(payload) as {
      _chunkedDataset?: unknown;
      _chunkedDeepUpdateReport?: unknown;
      chunkKeys?: unknown;
    };
    const isChunked = parsed._chunkedDataset === true || parsed._chunkedDeepUpdateReport === true;
    if (!isChunked) return null;
    if (!Array.isArray(parsed.chunkKeys) || parsed.chunkKeys.length === 0) return null;
    const chunkKeyPattern = /^[a-zA-Z0-9_-]{1,64}$/;
    const chunkKeys = parsed.chunkKeys.filter(
      (key): key is string => typeof key === "string" && chunkKeyPattern.test(key)
    );
    return chunkKeys.length === parsed.chunkKeys.length ? chunkKeys : null;
  } catch {
    return null;
  }
}

function buildLinkedCsvDatasetPayload(input: {
  fileName: string;
  uploadedAt: string;
  headers: string[];
  rows: Array<Record<string, unknown>>;
}): string {
  const headers = input.headers.map((header) => clean(header)).filter(Boolean);
  const rows = input.rows.map((row) => {
    const normalized: Record<string, string> = {};
    Object.entries(row).forEach(([key, value]) => {
      normalized[key] = value === null || value === undefined ? "" : String(value);
    });
    return normalized;
  });
  const csvEscape = (value: string): string => {
    if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
    return value;
  };
  const csvText = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(clean(row[header]))).join(",")),
  ].join("\n");

  const payload: LinkedCsvDatasetPayload = {
    fileName: clean(input.fileName) || "linked-upload.csv",
    uploadedAt: clean(input.uploadedAt) || new Date().toISOString(),
    headers,
    csvText,
    rows: rows.length <= 2000 ? rows : undefined,
  };

  return JSON.stringify(payload);
}

function parseLinkedCsvDatasetPayload(value: string): LinkedCsvDatasetPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<LinkedCsvDatasetPayload>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.headers)) return null;
    const headers = parsed.headers.map((header) => clean(header)).filter(Boolean);
    if (headers.length === 0) return null;

    const rows = Array.isArray(parsed.rows) && parsed.rows.length > 0
      ? parsed.rows.map((row) => {
          const normalized: Record<string, string> = {};
          Object.entries(row ?? {}).forEach(([key, cell]) => {
            normalized[key] = cell === null || cell === undefined ? "" : String(cell);
          });
          return normalized;
        })
      : parseRowsFromCsv(clean(parsed.csvText), headers);

    return {
      fileName: clean(parsed.fileName) || "linked-upload.csv",
      uploadedAt: clean(parsed.uploadedAt) || new Date().toISOString(),
      headers,
      csvText: clean(parsed.csvText),
      rows,
    };
  } catch {
    return null;
  }
}

function splitCityStateZip(rawValue: string | null | undefined): {
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const raw = clean(rawValue);
  if (!raw) return { city: null, state: null, zip: null };

  const normalized = raw.replace(/\s+/g, " ");
  const match = normalized.match(/^(.+?)[,\s]+([A-Za-z]{2,})\s+(\d{5}(?:-\d{4})?)$/);
  if (!match) return { city: normalized || null, state: null, zip: null };

  return {
    city: clean(match[1]) || null,
    state: clean(match[2]).toUpperCase() || null,
    zip: clean(match[3]) || null,
  };
}

function toContractTermsFromScan(rows: ContractScanResult[]): Map<string, ContractTerms> {
  const map = new Map<string, ContractTerms>();
  rows.forEach((row) => {
    if (!row.csgId || map.has(row.csgId)) return;
    const cityStateZipParts = splitCityStateZip(row.cityStateZip);
    map.set(row.csgId, {
      csgId: row.csgId,
      fileName: row.fileName,
      vendorFeePercent: row.vendorFeePercent,
      additionalCollateralPercent: row.additionalCollateralPercent,
      ccAuthorizationCompleted: row.ccAuthorizationCompleted,
      ccCardAsteriskCount: row.ccCardAsteriskCount,
      recQuantity: row.recQuantity,
      recPrice: row.recPrice,
      paymentMethod: row.paymentMethod,
      payeeName: row.payeeName,
      mailingAddress1: row.mailingAddress1,
      mailingAddress2: row.mailingAddress2,
      cityStateZip: row.cityStateZip,
      city: row.city ?? cityStateZipParts.city,
      state: row.state ?? cityStateZipParts.state,
      zip: row.zip ?? cityStateZipParts.zip,
    });
  });
  return map;
}

function linkedRowsToCsgMappings(rows: Array<Record<string, string>>): CsgSystemIdMappingRow[] {
  return rows
    .map((row) => {
      const csgId = getRowValueByAliases(row, ["csgId", "CSG ID", "CSGID"]);
      const systemId = getRowValueByAliases(row, ["systemId", "System ID", "state_certification_number"]);
      if (!csgId || !systemId) return null;
      return { csgId, systemId } satisfies CsgSystemIdMappingRow;
    })
    .filter((row): row is CsgSystemIdMappingRow => Boolean(row));
}

function linkedRowsToProjectApplications(rows: Array<Record<string, string>>): ProjectApplicationLiteRow[] {
  return rows
    .map((row) => {
      const applicationId = getRowValueByAliases(row, ["applicationId", "Application_ID"]);
      if (!applicationId) return null;
      const part1SubmissionDateRaw = getRowValueByAliases(row, ["part1SubmissionDate", "Part_1_Submission_Date"]);
      const part1OriginalDateRaw = getRowValueByAliases(
        row,
        ["part1OriginalSubmissionDate", "Part_1_Original_Submission_Date"]
      );
      return {
        applicationId,
        part1SubmissionDate: part1SubmissionDateRaw ? new Date(part1SubmissionDateRaw) : null,
        part1OriginalSubmissionDate: part1OriginalDateRaw ? new Date(part1OriginalDateRaw) : null,
        inverterSizeKwAcPart1: parseNumericCell(
          getRowValueByAliases(row, ["inverterSizeKwAcPart1", "Inverter_Size_kW_AC_Part_1"])
        ),
      } satisfies ProjectApplicationLiteRow;
    })
    .filter((row): row is ProjectApplicationLiteRow => Boolean(row));
}

function linkedRowsToQuickBooksInvoices(rows: Array<Record<string, string>>): Map<string, QuickBooksInvoice> {
  const grouped = new Map<string, QuickBooksInvoice>();

  rows.forEach((row) => {
    const invoiceNumber = getRowValueByAliases(row, ["invoiceNumber", "Num", "Invoice Number", "Invoice #"]);
    if (!invoiceNumber) return;

    const existing =
      grouped.get(invoiceNumber) ??
      ({
        invoiceNumber,
        amount: parseNumericCell(getRowValueByAliases(row, ["amount", "Amount", "Total"])),
        openBalance: parseNumericCell(getRowValueByAliases(row, ["openBalance", "Open balance", "Open Balance"])),
        cashReceived: parseNumericCell(getRowValueByAliases(row, ["cashReceived", "Cash Received"])),
        paymentStatus: getRowValueByAliases(row, ["paymentStatus", "Payment status", "Payment Status"]),
        voided: getRowValueByAliases(row, ["voided", "Voided"]),
        customer:
          getRowValueByAliases(row, ["customer", "Customer", "Customer full name", "Customer Full Name"]) ||
          "Unknown",
        date: getRowValueByAliases(row, ["date", "Date"]) ? new Date(getRowValueByAliases(row, ["date", "Date"])) : null,
        lineItems: [],
      } satisfies QuickBooksInvoice);

    const description = getRowValueByAliases(row, ["description", "Product/service description", "Description"]);
    const productService = getRowValueByAliases(row, ["productService", "Product/Service", "Product Service"]);
    const lineAmount = parseNumericCell(
      getRowValueByAliases(row, ["lineAmount", "Product/service amount line", "Line Amount"])
    );

    if (description || productService || lineAmount !== null) {
      existing.lineItems.push({
        lineOrder: parseNumericCell(getRowValueByAliases(row, ["lineOrder", "Line order", "Line Order"])),
        description,
        productService,
        amount: lineAmount,
      });
    }

    grouped.set(invoiceNumber, existing);
  });

  grouped.forEach((invoice) => {
    invoice.lineItems.sort((left, right) => {
      const leftOrder = left.lineOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.lineOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.description.localeCompare(right.description);
    });
  });

  return grouped;
}

function linkedRowsToInvoiceMapRows(rows: Array<Record<string, string>>): InvoiceNumberMapRow[] {
  return rows
    .map((row) => {
      const csgId = getRowValueByAliases(row, ["csgId", "CSG ID"]);
      const invoiceNumber = getRowValueByAliases(row, ["invoiceNumber", "Invoice Number"]);
      if (!csgId || !invoiceNumber) return null;
      return { csgId, invoiceNumber } satisfies InvoiceNumberMapRow;
    })
    .filter((row): row is InvoiceNumberMapRow => Boolean(row));
}

function linkedRowsToCsgPortalDatabaseRows(rows: Array<Record<string, string>>): CsgPortalDatabaseRow[] {
  return rows
    .map((row) => {
      const csgId = getRowValueByAliases(row, ["csgId", "CSG ID", "id", "system_id"]);
      if (!csgId) return null;

      return {
        systemId: getRowValueByAliases(row, ["systemId", "System ID", "state_certification_number"]),
        csgId,
        installerName: getRowValueByAliases(row, ["installerName", "Installer"]) || null,
        partnerCompanyName: getRowValueByAliases(row, ["partnerCompanyName", "Partner Company"]) || null,
        customerEmail: getRowValueByAliases(row, ["customerEmail", "Customer Email"]) || null,
        customerAltEmail: getRowValueByAliases(row, ["customerAltEmail", "Alt Email", "Alternate Email"]) || null,
        systemAddress: getRowValueByAliases(row, ["systemAddress", "System Address"]) || null,
        systemCity: getRowValueByAliases(row, ["systemCity", "System City"]) || null,
        systemState: getRowValueByAliases(row, ["systemState", "System State"]).toUpperCase() || null,
        systemZip: getRowValueByAliases(row, ["systemZip", "System Zip"]) || null,
        paymentNotes: getRowValueByAliases(row, ["paymentNotes", "Payment Notes"]) || null,
        collateralReimbursedToPartner: parseBooleanText(
          getRowValueByAliases(row, ["collateralReimbursedToPartner", "Collateral Reimbursed"])
        ),
      } satisfies CsgPortalDatabaseRow;
    })
    .filter((row): row is CsgPortalDatabaseRow => Boolean(row));
}

function parseIccContractRows(
  rows: Array<Record<string, string>>,
  sourceLabel: "icc2" | "icc3"
): IccContractRow[] {
  return rows
    .map((row) => {
      const applicationId = getRowValueByAliases(row, ["Application ID", "Application_ID", "application_id"]);
      if (!applicationId) return null;
      const recQuantity = parseNumericCell(
        getRowValueByAliases(row, ["Total Quantity of RECs Contracted", "Contracted SRECs", "SRECs"])
      );
      const recPrice = parseNumericCell(getRowValueByAliases(row, ["REC Price"]));
      const grossContractValue = parseNumericCell(
        getRowValueByAliases(row, ["Total REC Delivery Contract Value", "REC Delivery Contract Value", "Total Contract Value"])
      );
      const utilityName = getRowValueByAliases(row, ["Counterparty Utility", "Interconnecting Utility", "Utility"]) || null;
      return {
        applicationId,
        recQuantity,
        recPrice,
        grossContractValue,
        utilityName,
        systemAddressLine1: getRowValueByAliases(row, ["Address", "System Address", "Project Address"]),
        systemAddressLine2: getRowValueByAliases(row, ["Suite/Apt", "Suite", "Apt", "Address 2"]),
        systemCity: getRowValueByAliases(row, ["City", "System City"]),
        systemState: getRowValueByAliases(row, ["State", "System State"]).toUpperCase(),
        systemZip: getRowValueByAliases(row, ["Zip", "ZIP", "System Zip"]),
        sourceLabel,
      } satisfies IccContractRow;
    })
    .filter((row): row is IccContractRow => Boolean(row));
}

function buildIccMap(
  icc2Rows: Array<Record<string, string>>,
  icc3Rows: Array<Record<string, string>>
): Map<string, IccContractRow> {
  const map = new Map<string, IccContractRow>();
  parseIccContractRows(icc2Rows, "icc2").forEach((row) => {
    if (!map.has(row.applicationId)) map.set(row.applicationId, row);
  });
  parseIccContractRows(icc3Rows, "icc3").forEach((row) => {
    map.set(row.applicationId, row);
  });
  return map;
}

function toPortalSystemUrl(csgId: string): string {
  return `https://portal2.carbonsolutionsgroup.com/admin/solar_panel_system/${encodeURIComponent(csgId)}/edit?step=2.4`;
}

function resolveCsgIdHeader(headers: string[]): string | null {
  const preferred = headers.find((header) => {
    const normalized = normalizeAlias(header);
    return normalized === "csgid" || normalized === "id" || normalized === "systemid";
  });
  if (preferred) return preferred;
  return headers[0] ?? null;
}

export default function EarlyPayment() {
  const [, setLocation] = useLocation();
  const { user, loading: authLoading } = useAuth();

  const { mutateAsync: getDatasetAsync } =
    trpc.solarRecDashboard.getDataset.useMutation();
  const saveDatasetMutation = trpc.solarRecDashboard.saveDataset.useMutation();
  // Task 5.9 PR-A (2026-04-27): abpSettlement.* migrated to the
  // standalone Solar REC router. Early Payment isn't fully migrated
  // yet (Task 5.10), but its two `abpSettlement.*` call sites have
  // to follow the procedure to the new home or they 404 against
  // /api/trpc.
  const startScanJobMutation = trpc.abpSettlement.startContractScanJob.useMutation();
  const [activeScanJobId, setActiveScanJobId] = useState<string | null>(() =>
    typeof window !== "undefined" ? localStorage.getItem(ACTIVE_SCAN_JOB_STORAGE_KEY) : null
  );

  const scanJobQuery = trpc.abpSettlement.getJobStatus.useQuery(
    { jobId: activeScanJobId ?? "" },
    {
      enabled: Boolean(activeScanJobId),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        if (!status) return 1500;
        if (status === "queued" || status === "running") return 1500;
        return false;
      },
    }
  );

  const [monthKey, setMonthKey] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [firstPaymentPercent, setFirstPaymentPercent] = useState<15 | 20 | 100>(20);
  const [manualCsgInput, setManualCsgInput] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem(CSG_ID_STORAGE_KEY) ?? "" : ""
  );
  const [csgIdFileName, setCsgIdFileName] = useState<string | null>(() =>
    typeof window !== "undefined" ? localStorage.getItem(CSG_FILE_STORAGE_KEY) : null
  );
  const [csgIdsFromFile, setCsgIdsFromFile] = useState<string[]>([]);

  const [icc2Dataset, setIcc2Dataset] = useState<LinkedCsvDatasetPayload | null>(null);
  const [icc3Dataset, setIcc3Dataset] = useState<LinkedCsvDatasetPayload | null>(null);
  const [mappingDataset, setMappingDataset] = useState<LinkedCsvDatasetPayload | null>(null);
  const [quickBooksDataset, setQuickBooksDataset] = useState<LinkedCsvDatasetPayload | null>(null);
  const [projectAppsDataset, setProjectAppsDataset] = useState<LinkedCsvDatasetPayload | null>(null);
  const [invoiceMapDataset, setInvoiceMapDataset] = useState<LinkedCsvDatasetPayload | null>(null);
  const [portalDbDataset, setPortalDbDataset] = useState<LinkedCsvDatasetPayload | null>(null);

  const [uploadsHydrated, setUploadsHydrated] = useState(false);
  const [isSyncingUploads, setIsSyncingUploads] = useState(false);
  const [contractScanRows, setContractScanRows] = useState<ContractScanResult[]>([]);
  const [scanClockNow, setScanClockNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(CSG_ID_STORAGE_KEY, manualCsgInput);
  }, [manualCsgInput]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (csgIdFileName) localStorage.setItem(CSG_FILE_STORAGE_KEY, csgIdFileName);
    else localStorage.removeItem(CSG_FILE_STORAGE_KEY);
  }, [csgIdFileName]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeScanJobId) localStorage.setItem(ACTIVE_SCAN_JOB_STORAGE_KEY, activeScanJobId);
    else localStorage.removeItem(ACTIVE_SCAN_JOB_STORAGE_KEY);
  }, [activeScanJobId]);

  const loadDatasetPayload = useCallback(
    async (key: string): Promise<string | null> => {
      const result = await getDatasetAsync({ key });
      if (!result?.payload) return null;

      const chunkKeys = parseChunkPointerPayload(result.payload);
      if (!chunkKeys) return result.payload;

      const chunkPayloads = await Promise.all(
        chunkKeys.map((chunkKey) =>
          getDatasetAsync({ key: chunkKey })
            .then((chunkResult) => chunkResult?.payload ?? null)
            .catch(() => null)
        )
      );
      if (chunkPayloads.some((chunk) => chunk === null)) return null;
      return chunkPayloads.join("");
    },
    [getDatasetAsync]
  );

  const loadLinkedDataset = useCallback(
    async (key: string): Promise<LinkedCsvDatasetPayload | null> => {
      const payload = await loadDatasetPayload(key);
      if (!payload) return null;
      return parseLinkedCsvDatasetPayload(payload);
    },
    [loadDatasetPayload]
  );

  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;
    const run = async () => {
      try {
        const [
          mapping,
          quickBooks,
          projectApps,
          invoiceMap,
          portalDb,
          icc2,
          icc3,
        ] = await Promise.all([
          loadLinkedDataset(SHARED_DATASET_KEYS.csgSystemMapping),
          loadLinkedDataset(SHARED_DATASET_KEYS.quickBooks),
          loadLinkedDataset(SHARED_DATASET_KEYS.projectApplications),
          loadLinkedDataset(SHARED_DATASET_KEYS.portalInvoiceMap),
          loadLinkedDataset(SHARED_DATASET_KEYS.csgPortalDatabase),
          loadLinkedDataset(SHARED_DATASET_KEYS.iccReport2),
          loadLinkedDataset(SHARED_DATASET_KEYS.iccReport3),
        ]);

        const [deepIcc2, deepIcc3] = await Promise.all([
          icc2 ? Promise.resolve(null) : loadLinkedDataset(DEEP_UPDATE_COMPAT_KEYS.iccReport2),
          icc3 ? Promise.resolve(null) : loadLinkedDataset(DEEP_UPDATE_COMPAT_KEYS.iccReport3),
        ]);

        if (cancelled) return;
        setMappingDataset(mapping);
        setQuickBooksDataset(quickBooks);
        setProjectAppsDataset(projectApps);
        setInvoiceMapDataset(invoiceMap);
        setPortalDbDataset(portalDb);
        setIcc2Dataset(icc2 ?? deepIcc2);
        setIcc3Dataset(icc3 ?? deepIcc3);
      } catch (error) {
        if (!cancelled) toast.error(`Could not load shared uploads: ${toErrorMessage(error)}`);
      } finally {
        if (!cancelled) setUploadsHydrated(true);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user, loadLinkedDataset]);

  const saveLinkedDataset = useCallback(
    async (key: string, dataset: LinkedCsvDatasetPayload | null) => {
      const payload = dataset
        ? buildLinkedCsvDatasetPayload({
            fileName: dataset.fileName,
            uploadedAt: dataset.uploadedAt,
            headers: dataset.headers,
            rows: dataset.rows ?? [],
          })
        : "{}";
      await saveDatasetMutation.mutateAsync({ key, payload });
    },
    [saveDatasetMutation]
  );

  const uploadIccFile = useCallback(
    async (
      file: File,
      datasetKey: string,
      setDataset: (dataset: LinkedCsvDatasetPayload | null) => void,
      label: string
    ) => {
      setIsSyncingUploads(true);
      try {
        const parsed = await parseTabularFile(file);
        const hasRequiredHeaders = parsed.headers.some((header) => normalizeAlias(header) === "applicationid") &&
          parsed.headers.some((header) => normalizeAlias(header).includes("recprice"));
        if (!hasRequiredHeaders) {
          throw new Error(`${label} must include Application ID and REC Price columns.`);
        }

        const dataset: LinkedCsvDatasetPayload = {
          fileName: file.name,
          uploadedAt: new Date().toISOString(),
          headers: parsed.headers,
          csvText: "",
          rows: parsed.rows,
        };
        await saveLinkedDataset(datasetKey, dataset);
        if (datasetKey === SHARED_DATASET_KEYS.iccReport2) {
          await saveDatasetMutation.mutateAsync({
            key: DEEP_UPDATE_COMPAT_KEYS.iccReport2,
            payload: JSON.stringify({
              fileName: file.name,
              sheetName: "",
              headers: parsed.headers,
              rows: parsed.rows,
            }),
          });
        }
        if (datasetKey === SHARED_DATASET_KEYS.iccReport3) {
          await saveDatasetMutation.mutateAsync({
            key: DEEP_UPDATE_COMPAT_KEYS.iccReport3,
            payload: JSON.stringify({
              fileName: file.name,
              sheetName: "",
              headers: parsed.headers,
              rows: parsed.rows,
            }),
          });
        }
        setDataset(dataset);
        toast.success(`${label} uploaded (${parsed.rows.length.toLocaleString("en-US")} rows).`);
      } catch (error) {
        toast.error(`Failed to upload ${label}: ${toErrorMessage(error)}`);
      } finally {
        setIsSyncingUploads(false);
      }
    },
    [saveLinkedDataset, saveDatasetMutation]
  );

  const clearIccFile = useCallback(
    async (datasetKey: string, setDataset: (dataset: LinkedCsvDatasetPayload | null) => void, label: string) => {
      setIsSyncingUploads(true);
      try {
        await saveLinkedDataset(datasetKey, null);
        if (datasetKey === SHARED_DATASET_KEYS.iccReport2) {
          await saveDatasetMutation.mutateAsync({ key: DEEP_UPDATE_COMPAT_KEYS.iccReport2, payload: "" });
        }
        if (datasetKey === SHARED_DATASET_KEYS.iccReport3) {
          await saveDatasetMutation.mutateAsync({ key: DEEP_UPDATE_COMPAT_KEYS.iccReport3, payload: "" });
        }
        setDataset(null);
        toast.success(`${label} cleared.`);
      } catch (error) {
        toast.error(`Could not clear ${label}: ${toErrorMessage(error)}`);
      } finally {
        setIsSyncingUploads(false);
      }
    },
    [saveLinkedDataset, saveDatasetMutation]
  );

  useEffect(() => {
    const snapshot = scanJobQuery.data;
    if (!snapshot?.result?.rows) return;
    const rows = (snapshot.result.rows as Array<Record<string, unknown>>).map((row) => {
      const scan = (row.scan ?? {}) as Record<string, unknown>;
      const cityStateZip = clean(scan.cityStateZip);
      const cityStateZipParts = splitCityStateZip(cityStateZip || null);
      return {
        csgId: clean(row.csgId),
        fileName: clean(scan.fileName) || clean(row.pdfFileName) || `contract-${clean(row.csgId)}.pdf`,
        ccAuthorizationCompleted:
          typeof scan.ccAuthorizationCompleted === "boolean" ? scan.ccAuthorizationCompleted : null,
        ccCardAsteriskCount: parseNumericCell(scan.ccCardAsteriskCount),
        additionalCollateralPercent: parseNumericCell(scan.additionalCollateralPercent),
        vendorFeePercent: parseNumericCell(scan.vendorFeePercent),
        recQuantity: parseNumericCell(scan.recQuantity),
        recPrice: parseNumericCell(scan.recPrice),
        paymentMethod: clean(scan.paymentMethod) || null,
        payeeName: clean(scan.payeeName) || null,
        mailingAddress1: clean(scan.mailingAddress1) || null,
        mailingAddress2: clean(scan.mailingAddress2) || null,
        cityStateZip: cityStateZip || null,
        city: clean(scan.city) || cityStateZipParts.city,
        state: clean(scan.state) || cityStateZipParts.state,
        zip: clean(scan.zip) || cityStateZipParts.zip,
        error: clean(row.error) || null,
      } satisfies ContractScanResult;
    });
    setContractScanRows(rows);
  }, [scanJobQuery.data]);

  const scanInFlight = scanJobQuery.data?.status === "queued" || scanJobQuery.data?.status === "running";
  const scanProgress = scanJobQuery.data?.progress ?? null;

  useEffect(() => {
    if (!scanInFlight) return;
    const interval = window.setInterval(() => setScanClockNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [scanInFlight]);

  const scanElapsedMs = useMemo(() => {
    const startedAt = scanJobQuery.data?.startedAt;
    if (!startedAt || !scanInFlight) return null;
    const startedMs = Date.parse(startedAt);
    if (!Number.isFinite(startedMs)) return null;
    return Math.max(0, scanClockNow - startedMs);
  }, [scanJobQuery.data?.startedAt, scanClockNow, scanInFlight]);

  const scanRemainingMs = useMemo(() => {
    if (!scanInFlight || !scanProgress || scanElapsedMs === null) return null;
    if (scanProgress.current <= 0 || scanProgress.total <= 0) return null;
    const avg = scanElapsedMs / scanProgress.current;
    const remaining = Math.max(0, scanProgress.total - scanProgress.current);
    return avg * remaining;
  }, [scanElapsedMs, scanInFlight, scanProgress]);

  const selectedCsgIds = useMemo(() => {
    return Array.from(new Set([...parseCsgIds(manualCsgInput), ...csgIdsFromFile]));
  }, [manualCsgInput, csgIdsFromFile]);

  const csgSystemMappings = useMemo(
    () => linkedRowsToCsgMappings(mappingDataset?.rows ?? []),
    [mappingDataset?.rows]
  );
  const quickBooksByInvoice = useMemo(
    () => linkedRowsToQuickBooksInvoices(quickBooksDataset?.rows ?? []),
    [quickBooksDataset?.rows]
  );
  const projectApplications = useMemo(
    () => linkedRowsToProjectApplications(projectAppsDataset?.rows ?? []),
    [projectAppsDataset?.rows]
  );
  const invoiceMapRows = useMemo(
    () => linkedRowsToInvoiceMapRows(invoiceMapDataset?.rows ?? []),
    [invoiceMapDataset?.rows]
  );
  const csgPortalDatabaseRows = useMemo(
    () => linkedRowsToCsgPortalDatabaseRows(portalDbDataset?.rows ?? []),
    [portalDbDataset?.rows]
  );
  const contractTermsByCsgId = useMemo(() => toContractTermsFromScan(contractScanRows), [contractScanRows]);
  const iccMapByApplicationId = useMemo(
    () => buildIccMap(icc2Dataset?.rows ?? [], icc3Dataset?.rows ?? []),
    [icc2Dataset?.rows, icc3Dataset?.rows]
  );

  const invoiceNumberByCsgId = useMemo(() => {
    const map = new Map<string, string>();
    invoiceMapRows.forEach((row) => {
      if (!map.has(row.csgId)) map.set(row.csgId, row.invoiceNumber);
    });
    return map;
  }, [invoiceMapRows]);

  const syntheticInput = useMemo(() => {
    const mappingByCsg = new Map<string, string>();
    csgSystemMappings.forEach((row) => {
      if (!mappingByCsg.has(row.csgId)) mappingByCsg.set(row.csgId, row.systemId);
    });

    const utilityRows: UtilityInvoiceRow[] = [];
    const issues: CsgIdImportIssue[] = [];

    selectedCsgIds.forEach((csgId) => {
      const systemId = mappingByCsg.get(csgId);
      if (!systemId) {
        issues.push({ csgId, reason: "Missing CSG→ABP mapping (System ID)." });
        return;
      }

      const iccRow = iccMapByApplicationId.get(systemId);
      if (!iccRow) {
        issues.push({
          csgId,
          reason: `No ICC Report 2/3 match found for Application ID ${systemId}.`,
        });
        return;
      }

      let recQuantity = iccRow.recQuantity;
      let recPrice = iccRow.recPrice;
      let grossContractValue = iccRow.grossContractValue;

      if ((grossContractValue === null || grossContractValue <= 0) && recQuantity !== null && recPrice !== null) {
        grossContractValue = roundMoney(recQuantity * recPrice);
      }
      if ((recPrice === null || recPrice <= 0) && grossContractValue !== null && grossContractValue > 0 && recQuantity !== null && recQuantity > 0) {
        recPrice = roundMoney(grossContractValue / recQuantity);
      }
      if ((recQuantity === null || recQuantity <= 0) && grossContractValue !== null && grossContractValue > 0 && recPrice !== null && recPrice > 0) {
        recQuantity = roundMoney(grossContractValue / recPrice);
      }

      const resolvedGross = grossContractValue ?? 0;
      const resolvedRecs = recQuantity ?? 0;
      const resolvedPrice = recPrice ?? 0;
      if (resolvedGross <= 0 || resolvedRecs <= 0 || resolvedPrice <= 0) {
        issues.push({
          csgId,
          reason: "ICC data is missing gross contract value / REC quantity / REC price.",
        });
        return;
      }

      const invoiceAmount = roundMoney((resolvedGross * firstPaymentPercent) / 100);
      const addressLine1 = clean(iccRow.systemAddressLine1);
      const addressLine2 = clean(iccRow.systemAddressLine2);
      const cityStateZip = [clean(iccRow.systemCity), clean(iccRow.systemState), clean(iccRow.systemZip)]
        .filter(Boolean)
        .join(" ");
      const systemAddress = [addressLine1, addressLine2, cityStateZip].filter(Boolean).join(", ");

      utilityRows.push({
        rowId: `early-payment:${csgId}:${systemId}`,
        sourceFile: "early-payment",
        sourceSheet: iccRow.sourceLabel,
        contractId: null,
        utilityName: iccRow.utilityName ?? null,
        systemId,
        paymentNumber: 1,
        recQuantity: resolvedRecs,
        recPrice: resolvedPrice,
        invoiceAmount,
        systemAddress,
      });
    });

    return { utilityRows, issues };
  }, [csgSystemMappings, firstPaymentPercent, iccMapByApplicationId, selectedCsgIds]);

  const computationResult = useMemo(() => {
    if (syntheticInput.utilityRows.length === 0) return null;

    const invoiceNumberToSystemId = buildInvoiceNumberToSystemIdMap({
      invoiceNumberMapRows: invoiceMapRows,
      csgSystemMappings,
    });
    const knownSystemIds = new Set(csgSystemMappings.map((row) => clean(row.systemId)).filter(Boolean));
    const quickBooksLedger = buildQuickBooksPaidUpfrontLedger({
      quickBooksByInvoice,
      knownSystemIds,
      invoiceNumberToSystemId,
    });

    return computeSettlementRows({
      utilityRows: syntheticInput.utilityRows,
      csgSystemMappings,
      projectApplications,
      quickBooksPaidUpfrontLedger: quickBooksLedger,
      contractTermsByCsgId,
      csgPortalDatabaseRows,
      previousCarryforwardBySystemId: {},
      manualOverridesByRowId: {},
    });
  }, [
    syntheticInput.utilityRows,
    invoiceMapRows,
    csgSystemMappings,
    quickBooksByInvoice,
    projectApplications,
    contractTermsByCsgId,
    csgPortalDatabaseRows,
  ]);

  const issues = useMemo(() => {
    const fromCompute = computationResult?.warnings.map((warning) => ({ csgId: "-", reason: warning })) ?? [];
    return [...syntheticInput.issues, ...fromCompute];
  }, [computationResult?.warnings, syntheticInput.issues]);

  const handleUploadCsgIds = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    try {
      const parsed = await parseTabularFile(file);
      const csgHeader = resolveCsgIdHeader(parsed.headers);
      if (!csgHeader) throw new Error("No header found in uploaded file.");

      const imported = parsed.rows
        .map((row) => clean(row[csgHeader]))
        .filter(Boolean);
      setCsgIdsFromFile(Array.from(new Set(imported)));
      setCsgIdFileName(file.name);
      toast.success(`Loaded ${imported.length.toLocaleString("en-US")} CSG IDs from ${file.name}.`);
    } catch (error) {
      toast.error(`Failed to import CSG IDs: ${toErrorMessage(error)}`);
    }
  };

  const handleStartScan = async () => {
    if (selectedCsgIds.length === 0) {
      toast.error("Add at least one CSG ID before starting contract scan.");
      return;
    }
    try {
      const response = await startScanJobMutation.mutateAsync({
        csgIds: selectedCsgIds,
      });
      setActiveScanJobId(response.jobId);
      toast.success(`Started scan job for ${selectedCsgIds.length.toLocaleString("en-US")} CSG IDs.`);
    } catch (error) {
      toast.error(`Could not start scan job: ${toErrorMessage(error)}`);
    }
  };

  const handleExport = () => {
    if (!computationResult || computationResult.rows.length === 0) {
      toast.error("No rows are available to export.");
      return;
    }
    const csv = buildSettlementCsv(computationResult.rows);
    downloadTextFile(`early-payment-settlement-${monthKey}.csv`, csv, "text/csv;charset=utf-8");
    toast.success("Early payment settlement CSV exported.");
  };

  const rowsByCsgId = useMemo(() => {
    const map = new Map<string, PaymentComputationRow>();
    (computationResult?.rows ?? []).forEach((row) => {
      if (row.csgId && !map.has(row.csgId)) map.set(row.csgId, row);
    });
    return map;
  }, [computationResult?.rows]);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 md:px-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-slate-900">Early Payment Module</h1>
          <p className="text-sm text-slate-600">
            Import CSG IDs, match to ABP IDs via shared ICC Report 2/3, scan contracts, and generate ABP-style payout rows without utility invoice files.
          </p>
        </div>
        <Button variant="outline" onClick={() => setLocation("/abp-invoice-settlement")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          ABP Settlement
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1) Inputs</CardTitle>
          <CardDescription>
            Upload ICC reports here or from Solar REC Dashboard. These slots are shared and overwrite each other across modules.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="month-key">Run Month (YYYY-MM)</Label>
              <Input id="month-key" value={monthKey} onChange={(event) => setMonthKey(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="first-payment-percent">Early Payment Assumption</Label>
              <select
                id="first-payment-percent"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={firstPaymentPercent}
                onChange={(event) =>
                  setFirstPaymentPercent(event.target.value === "100" ? 100 : event.target.value === "15" ? 15 : 20)
                }
              >
                <option value="20">20% first payment</option>
                <option value="15">15% first payment</option>
                <option value="100">100% upfront payment</option>
              </select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-md border border-slate-200 p-3">
              <Label htmlFor="csg-id-file">CSG ID Upload (.csv/.xlsx)</Label>
              <Input
                id="csg-id-file"
                type="file"
                accept=".csv,.xlsx,.xls,.xlsm,.xlsb"
                onChange={(event) => {
                  void handleUploadCsgIds(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
              <div className="text-xs text-slate-600">
                {csgIdFileName ? `Loaded: ${csgIdFileName} (${csgIdsFromFile.length.toLocaleString("en-US")} IDs)` : "No CSG ID file loaded."}
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCsgIdsFromFile([]);
                  setCsgIdFileName(null);
                  toast.success("CSG ID file cleared.");
                }}
                disabled={!csgIdFileName}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                Clear CSG File
              </Button>
            </div>

            <div className="space-y-2 rounded-md border border-slate-200 p-3">
              <Label htmlFor="manual-csg">Manual CSG IDs (one per line or comma-separated)</Label>
              <Textarea
                id="manual-csg"
                value={manualCsgInput}
                onChange={(event) => setManualCsgInput(event.target.value)}
                className="min-h-[112px]"
                placeholder="177418, 7754, 12345"
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-md border border-slate-200 p-3">
              <Label htmlFor="icc-report-2">ICC Report 2 (shared)</Label>
              <Input
                id="icc-report-2"
                type="file"
                accept=".csv,.xlsx,.xls,.xlsm,.xlsb"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0] ?? null;
                  if (file) {
                    void uploadIccFile(file, SHARED_DATASET_KEYS.iccReport2, setIcc2Dataset, "ICC Report 2");
                  }
                  event.currentTarget.value = "";
                }}
                disabled={isSyncingUploads}
              />
              <div className="text-xs text-slate-600">
                {icc2Dataset
                  ? `${icc2Dataset.fileName} • ${(icc2Dataset.rows?.length ?? 0).toLocaleString("en-US")} rows`
                  : "Not uploaded"}
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void clearIccFile(SHARED_DATASET_KEYS.iccReport2, setIcc2Dataset, "ICC Report 2")}
                disabled={!icc2Dataset || isSyncingUploads}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                Delete
              </Button>
            </div>

            <div className="space-y-2 rounded-md border border-slate-200 p-3">
              <Label htmlFor="icc-report-3">ICC Report 3 (shared)</Label>
              <Input
                id="icc-report-3"
                type="file"
                accept=".csv,.xlsx,.xls,.xlsm,.xlsb"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0] ?? null;
                  if (file) {
                    void uploadIccFile(file, SHARED_DATASET_KEYS.iccReport3, setIcc3Dataset, "ICC Report 3");
                  }
                  event.currentTarget.value = "";
                }}
                disabled={isSyncingUploads}
              />
              <div className="text-xs text-slate-600">
                {icc3Dataset
                  ? `${icc3Dataset.fileName} • ${(icc3Dataset.rows?.length ?? 0).toLocaleString("en-US")} rows`
                  : "Not uploaded"}
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void clearIccFile(SHARED_DATASET_KEYS.iccReport3, setIcc3Dataset, "ICC Report 3")}
                disabled={!icc3Dataset || isSyncingUploads}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
            <div className="font-medium text-slate-800">Shared dataset availability</div>
            <div className="mt-1 grid gap-1 md:grid-cols-2">
              <div>CSG↔ABP Mapping: {mappingDataset ? "Loaded" : "Missing"}</div>
              <div>QuickBooks: {quickBooksDataset ? "Loaded" : "Missing"}</div>
              <div>ProjectApplication: {projectAppsDataset ? "Loaded" : "Missing"}</div>
              <div>Portal Invoice Map: {invoiceMapDataset ? "Loaded" : "Missing"}</div>
              <div>CSG Portal Database: {portalDbDataset ? "Loaded" : "Missing"}</div>
            </div>
            <div className="mt-2 text-slate-600">
              Manage shared uploads in{" "}
              <a className="underline" href="/solar-rec-dashboard">
                Solar REC Dashboard
              </a>{" "}
              or{" "}
              <a className="underline" href="/abp-invoice-settlement">
                ABP Settlement
              </a>
              .
            </div>
          </div>
          {!uploadsHydrated ? (
            <div className="text-xs text-slate-500">Restoring shared uploads...</div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2) Contract Scan (Optional but recommended)</CardTitle>
          <CardDescription>
            Uses CSG IDs only. This pulls vendor fee, additional collateral, CC auth, and payment method/payee/mailing fields.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline">Selected CSG IDs: {selectedCsgIds.length.toLocaleString("en-US")}</Badge>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleStartScan()}
              disabled={startScanJobMutation.isPending || selectedCsgIds.length === 0}
            >
              {startScanJobMutation.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-1 h-3.5 w-3.5" />
              )}
              Start Scan
            </Button>
          </div>

          {scanInFlight && scanProgress ? (
            <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="flex justify-between text-xs text-slate-600">
                <span>{scanProgress.message}</span>
                <span>
                  {scanProgress.current}/{scanProgress.total}
                </span>
              </div>
              <Progress value={scanProgress.percent} />
              <div className="grid gap-1 text-xs text-slate-600 sm:grid-cols-3">
                <div>Current CSG ID: {scanProgress.currentCsgId ?? "-"}</div>
                <div>Time elapsed: {formatDuration(scanElapsedMs)}</div>
                <div>Time remaining: {scanRemainingMs === null ? "Calculating..." : formatDuration(scanRemainingMs)}</div>
              </div>
            </div>
          ) : null}

          {activeScanJobId ? (
            <div className="text-xs text-slate-500">Active scan job: {activeScanJobId}</div>
          ) : null}

          <div className="max-h-72 overflow-auto rounded-md border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>CSG ID</TableHead>
                  <TableHead>PDF</TableHead>
                  <TableHead>Vendor Fee %</TableHead>
                  <TableHead>Additional Collateral %</TableHead>
                  <TableHead>Payment Method</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contractScanRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-xs text-slate-500">
                      No scan rows yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  contractScanRows.map((row) => (
                    <TableRow key={`${row.csgId}:${row.fileName}`}>
                      <TableCell>{row.csgId}</TableCell>
                      <TableCell className="max-w-[220px] truncate">{row.fileName}</TableCell>
                      <TableCell>{row.vendorFeePercent === null ? "" : `${row.vendorFeePercent.toFixed(2)}%`}</TableCell>
                      <TableCell>{row.additionalCollateralPercent === null ? "" : `${row.additionalCollateralPercent.toFixed(2)}%`}</TableCell>
                      <TableCell>{clean(row.paymentMethod)}</TableCell>
                      <TableCell>{clean(row.payeeName)}</TableCell>
                      <TableCell className="text-rose-700">{clean(row.error)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3) Early Payment Output</CardTitle>
          <CardDescription>
            Settlement-style output built from ICC + shared ABP files. Utility invoice input is replaced with your selected early-payment percentage assumption.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              Computed Rows: {computationResult?.rows.length.toLocaleString("en-US") ?? "0"}
            </Badge>
            <Badge variant="outline">
              Issues: {issues.length.toLocaleString("en-US")}
            </Badge>
            <Button type="button" onClick={handleExport} disabled={!computationResult || computationResult.rows.length === 0}>
              <Download className="mr-1.5 h-4 w-4" />
              Export CSV
            </Button>
          </div>

          {issues.length > 0 ? (
            <div className="max-h-40 overflow-auto rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              {issues.slice(0, 100).map((issue, index) => (
                <div key={`${issue.csgId}:${issue.reason}:${index}`}>
                  {issue.csgId !== "-" ? `${issue.csgId}: ` : ""}{issue.reason}
                </div>
              ))}
            </div>
          ) : null}

          <div className="max-h-[520px] overflow-auto rounded-md border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>CSG ID</TableHead>
                  <TableHead>ABP ID</TableHead>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Invoice Amt</TableHead>
                  <TableHead>RECs</TableHead>
                  <TableHead>REC Price</TableHead>
                  <TableHead>Gross Value</TableHead>
                  <TableHead>Payment #</TableHead>
                  <TableHead>Vendor Fee</TableHead>
                  <TableHead>Additional Collateral</TableHead>
                  <TableHead>First Payment Formula Net</TableHead>
                  <TableHead>Payment Method</TableHead>
                  <TableHead>Portal</TableHead>
                  <TableHead>Links</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(computationResult?.rows ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={14} className="text-center text-xs text-slate-500">
                      No output rows yet. Upload ICC reports and add valid CSG IDs.
                    </TableCell>
                  </TableRow>
                ) : (
                  (computationResult?.rows ?? []).map((row) => (
                    <TableRow key={row.rowId}>
                      <TableCell>{row.csgId ?? ""}</TableCell>
                      <TableCell>{row.systemId}</TableCell>
                      <TableCell>{row.csgId ? clean(invoiceNumberByCsgId.get(row.csgId)) : ""}</TableCell>
                      <TableCell>{formatCurrency(row.invoiceAmount)}</TableCell>
                      <TableCell>{row.recQuantity.toLocaleString("en-US")}</TableCell>
                      <TableCell>{formatCurrency(row.recPrice)}</TableCell>
                      <TableCell>{formatCurrency(row.grossContractValue)}</TableCell>
                      <TableCell>{row.paymentNumber ?? ""}</TableCell>
                      <TableCell>{formatCurrency(row.vendorFeeAmount)}</TableCell>
                      <TableCell>{formatCurrency(row.additionalCollateralAmount)}</TableCell>
                      <TableCell>{formatCurrency(row.firstPaymentFormulaNetAmount)}</TableCell>
                      <TableCell>{row.paymentMethod}</TableCell>
                      <TableCell>
                        {row.csgId ? (
                          <a
                            href={toPortalSystemUrl(row.csgId)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-blue-700 hover:underline"
                          >
                            Open
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1 text-xs">
                          <a href="/abp-invoice-settlement" className="inline-flex items-center gap-1 text-slate-700 hover:underline">
                            ABP Settlement
                          </a>
                          <a href="/contract-scanner" className="inline-flex items-center gap-1 text-slate-700 hover:underline">
                            <FileSearch className="h-3.5 w-3.5" />
                            Contract Scanner
                          </a>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
            <div>Last scan update: {formatDateTime(scanJobQuery.data?.updatedAt ?? null)}</div>
            <div>
              Uploaded ICC rows: {(icc2Dataset?.rows?.length ?? 0).toLocaleString("en-US")} (Report 2),{" "}
              {(icc3Dataset?.rows?.length ?? 0).toLocaleString("en-US")} (Report 3)
            </div>
            <div>Selected CSG IDs: {selectedCsgIds.length.toLocaleString("en-US")}</div>
            <div>Matched output rows: {rowsByCsgId.size.toLocaleString("en-US")}</div>
          </div>
        </CardContent>
      </Card>

      <AskAiPanel
        moduleKey="early-payment"
        title="Ask AI about this early-payment run"
        contextGetter={() => ({
          runConfig: { monthKey },
          inputs: {
            icc2Rows: icc2Dataset?.rows?.length ?? 0,
            icc3Rows: icc3Dataset?.rows?.length ?? 0,
            selectedCsgIds: selectedCsgIds.length,
            matchedOutputRows: rowsByCsgId.size,
          },
          scanJob: scanJobQuery.data
            ? {
                status: scanJobQuery.data.status,
                startedAt: scanJobQuery.data.startedAt ?? null,
                updatedAt: scanJobQuery.data.updatedAt ?? null,
                progress: scanJobQuery.data.progress ?? null,
              }
            : null,
          sampleComputedRows: Array.from(rowsByCsgId.values())
            .slice(0, 20)
            .map((r) => ({
              csgId: r.csgId,
              systemId: r.systemId,
              classification: r.classification,
              grossContractValue: r.grossContractValue,
              vendorFeeAmount: r.vendorFeeAmount,
              netPayoutThisRow: r.netPayoutThisRow,
              recQuantity: r.recQuantity,
            })),
        })}
      />
    </div>
  );
}
