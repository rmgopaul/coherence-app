import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  buildInvoiceNumberToSystemIdMap,
  buildQuickBooksPaidUpfrontLedger,
  buildSettlementCsv,
  computeSettlementRows,
  detectInvoiceNumberMapHeaders,
  parseCsgSystemMapping,
  parseInvoiceNumberMap,
  parseProjectApplications,
  parseQuickBooksDetailedReport,
  parseTabularFile,
  parseUtilityInvoiceFile,
  type ContractTerms,
  type ManualOverride,
  type PaymentClassification,
  type PaymentComputationRow,
  type ProjectApplicationLiteRow,
  type QuickBooksInvoice,
  type UtilityInvoiceRow,
  type CsgSystemIdMappingRow,
  type InvoiceNumberMapRow,
  type ParsedTabularData,
} from "@/lib/abpSettlement";
import {
  ArrowLeft,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type RunInputs = {
  utilityInvoiceFiles: string[];
  csgSystemMappingFile: string | null;
  quickBooksFile: string | null;
  projectApplicationFile: string | null;
  portalInvoiceMapFile: string | null;
};

type ContractFetchResult = {
  csgId: string;
  systemPageUrl: string;
  pdfUrl: string | null;
  pdfFileName: string | null;
  error: string | null;
};

type ContractScanResult = {
  csgId: string;
  fileName: string;
  ccAuthorizationCompleted: boolean | null;
  ccCardAsteriskCount: number | null;
  additionalFivePercentSelected: boolean | null;
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

type PersistedProjectApplicationRow = {
  applicationId: string;
  part1SubmissionDate: string | null;
  part1OriginalSubmissionDate: string | null;
  inverterSizeKwAcPart1: number | null;
};

type PersistedQuickBooksInvoice = Omit<QuickBooksInvoice, "date"> & {
  date: string | null;
};

type SavedRunPayload = {
  version: 1;
  monthKey: string;
  label: string | null;
  savedAt: string;
  runInputs: RunInputs;
  utilityRows: UtilityInvoiceRow[];
  csgSystemMappings: CsgSystemIdMappingRow[];
  projectApplications: PersistedProjectApplicationRow[];
  quickBooksInvoices: PersistedQuickBooksInvoice[];
  invoiceNumberMapRows: InvoiceNumberMapRow[];
  contractTerms: ContractTerms[];
  manualOverridesByRowId: Record<string, ManualOverride>;
  previousCarryforwardBySystemId: Record<string, number>;
  computedRows: PaymentComputationRow[];
  warnings: string[];
  carryforwardBySystemId: Record<string, number>;
};

type RunSummary = {
  runId: string;
  monthKey: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
  rowCount: number | null;
};

const CURRENCY_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error.";
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "$0.00";
  return CURRENCY_FORMATTER.format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return `${value.toFixed(2)}%`;
}

function formatDateTime(iso: string | null | undefined): string {
  const parsed = clean(iso);
  if (!parsed) return "";
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime())) return parsed;
  return date.toLocaleString("en-US");
}

function downloadTextFile(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function buildMonthKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
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

function parseNumberInput(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function serializeProjectApplications(rows: ProjectApplicationLiteRow[]): PersistedProjectApplicationRow[] {
  return rows.map((row) => ({
    applicationId: row.applicationId,
    part1SubmissionDate: row.part1SubmissionDate ? row.part1SubmissionDate.toISOString() : null,
    part1OriginalSubmissionDate: row.part1OriginalSubmissionDate
      ? row.part1OriginalSubmissionDate.toISOString()
      : null,
    inverterSizeKwAcPart1: row.inverterSizeKwAcPart1,
  }));
}

function deserializeProjectApplications(rows: PersistedProjectApplicationRow[]): ProjectApplicationLiteRow[] {
  return rows.map((row) => ({
    applicationId: clean(row.applicationId),
    part1SubmissionDate: row.part1SubmissionDate ? new Date(row.part1SubmissionDate) : null,
    part1OriginalSubmissionDate: row.part1OriginalSubmissionDate
      ? new Date(row.part1OriginalSubmissionDate)
      : null,
    inverterSizeKwAcPart1:
      typeof row.inverterSizeKwAcPart1 === "number" && Number.isFinite(row.inverterSizeKwAcPart1)
        ? row.inverterSizeKwAcPart1
        : null,
  }));
}

function serializeQuickBooksInvoices(invoices: Map<string, QuickBooksInvoice>): PersistedQuickBooksInvoice[] {
  return Array.from(invoices.values()).map((invoice) => ({
    ...invoice,
    date: invoice.date ? invoice.date.toISOString() : null,
  }));
}

function deserializeQuickBooksInvoices(invoices: PersistedQuickBooksInvoice[]): Map<string, QuickBooksInvoice> {
  const map = new Map<string, QuickBooksInvoice>();
  invoices.forEach((invoice) => {
    const key = clean(invoice.invoiceNumber);
    if (!key) return;
    map.set(key, {
      ...invoice,
      date: invoice.date ? new Date(invoice.date) : null,
    });
  });
  return map;
}

function toContractTermsFromScan(rows: ContractScanResult[]): Map<string, ContractTerms> {
  const map = new Map<string, ContractTerms>();
  rows.forEach((row) => {
    if (!row.csgId || row.error) return;
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

function isClassification(value: string): value is PaymentClassification {
  return (
    value === "first_full_upfront" ||
    value === "first_partial" ||
    value === "quarterly" ||
    value === "unknown"
  );
}

export default function AbpInvoiceSettlement() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const [monthKey, setMonthKey] = useState(buildMonthKey());
  const [runLabel, setRunLabel] = useState("");
  const [runInputs, setRunInputs] = useState<RunInputs>({
    utilityInvoiceFiles: [],
    csgSystemMappingFile: null,
    quickBooksFile: null,
    projectApplicationFile: null,
    portalInvoiceMapFile: null,
  });

  const [utilityRows, setUtilityRows] = useState<UtilityInvoiceRow[]>([]);
  const [csgSystemMappings, setCsgSystemMappings] = useState<CsgSystemIdMappingRow[]>([]);
  const [projectApplications, setProjectApplications] = useState<ProjectApplicationLiteRow[]>([]);
  const [quickBooksByInvoice, setQuickBooksByInvoice] = useState<Map<string, QuickBooksInvoice>>(new Map());

  const [invoiceMapParsed, setInvoiceMapParsed] = useState<ParsedTabularData | null>(null);
  const [savedInvoiceNumberMapRows, setSavedInvoiceNumberMapRows] = useState<InvoiceNumberMapRow[]>([]);
  const [invoiceMapHeaderSelection, setInvoiceMapHeaderSelection] = useState<{
    csgIdHeader: string | null;
    invoiceNumberHeader: string | null;
  }>({ csgIdHeader: null, invoiceNumberHeader: null });

  const [manualOverridesByRowId, setManualOverridesByRowId] = useState<Record<string, ManualOverride>>({});
  const [previousCarryforwardBySystemId, setPreviousCarryforwardBySystemId] =
    useState<Record<string, number>>({});

  const [contractFetchRows, setContractFetchRows] = useState<ContractFetchResult[]>([]);
  const [contractScanRows, setContractScanRows] = useState<ContractScanResult[]>([]);
  const [contractTermsByCsgId, setContractTermsByCsgId] = useState<Map<string, ContractTerms>>(new Map());

  const [manualScanIdInput, setManualScanIdInput] = useState("");
  const [activeScanJobId, setActiveScanJobId] = useState<string | null>(null);

  const [portalEmail, setPortalEmail] = useState("");
  const [portalPassword, setPortalPassword] = useState("");
  const [portalBaseUrl, setPortalBaseUrl] = useState("https://portal2.carbonsolutionsgroup.com");

  const [isUploadingUtility, setIsUploadingUtility] = useState(false);
  const [isUploadingMapping, setIsUploadingMapping] = useState(false);
  const [isUploadingQuickBooks, setIsUploadingQuickBooks] = useState(false);
  const [isUploadingProjectApps, setIsUploadingProjectApps] = useState(false);
  const [isUploadingInvoiceMap, setIsUploadingInvoiceMap] = useState(false);
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null);

  const csgPortalStatusQuery = trpc.csgPortal.status.useQuery(undefined, {
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const savedRunsQuery = trpc.abpSettlement.listRuns.useQuery(
    { limit: 100 },
    {
      enabled: !!user,
      retry: false,
      refetchOnWindowFocus: false,
    }
  );

  const startScanJobMutation = trpc.abpSettlement.startContractScanJob.useMutation();
  const savePortalCredentialsMutation = trpc.csgPortal.saveCredentials.useMutation();
  const testPortalConnectionMutation = trpc.csgPortal.testConnection.useMutation();
  const saveRunMutation = trpc.abpSettlement.saveRun.useMutation();

  const scanJobQuery = trpc.abpSettlement.getJobStatus.useQuery(
    { jobId: activeScanJobId ?? "__none__" },
    {
      enabled: Boolean(activeScanJobId),
      refetchInterval: activeScanJobId ? 1200 : false,
      retry: 1,
      refetchOnWindowFocus: false,
    }
  );

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, setLocation, user]);

  useEffect(() => {
    if (!csgPortalStatusQuery.data) return;
    if (csgPortalStatusQuery.data.email) setPortalEmail(csgPortalStatusQuery.data.email);
    if (csgPortalStatusQuery.data.baseUrl) setPortalBaseUrl(csgPortalStatusQuery.data.baseUrl);
  }, [csgPortalStatusQuery.data]);

  useEffect(() => {
    const snapshot = scanJobQuery.data;
    if (!snapshot || !activeScanJobId) return;

    if (snapshot.status === "completed") {
      setActiveScanJobId(null);
      const rows = snapshot.result?.rows ?? [];
      const fetchedRows: ContractFetchResult[] = rows.map((row) => ({
        csgId: row.csgId,
        systemPageUrl: row.systemPageUrl,
        pdfUrl: row.pdfUrl,
        pdfFileName: row.pdfFileName,
        error: row.error,
      }));
      const scannedRows: ContractScanResult[] = rows.map((row) => {
        const cityStateZipParts = splitCityStateZip(row.scan?.cityStateZip ?? null);
        return {
          csgId: row.csgId,
          fileName: row.scan?.fileName ?? row.pdfFileName ?? `contract-${row.csgId}.pdf`,
          ccAuthorizationCompleted: row.scan?.ccAuthorizationCompleted ?? null,
          ccCardAsteriskCount: row.scan?.ccCardAsteriskCount ?? null,
          additionalFivePercentSelected: row.scan?.additionalFivePercentSelected ?? null,
          additionalCollateralPercent: row.scan?.additionalCollateralPercent ?? null,
          vendorFeePercent: row.scan?.vendorFeePercent ?? null,
          recQuantity: row.scan?.recQuantity ?? null,
          recPrice: row.scan?.recPrice ?? null,
          paymentMethod: row.scan?.paymentMethod ?? null,
          payeeName: row.scan?.payeeName ?? null,
          mailingAddress1: row.scan?.mailingAddress1 ?? null,
          mailingAddress2: row.scan?.mailingAddress2 ?? null,
          cityStateZip: row.scan?.cityStateZip ?? null,
          city: cityStateZipParts.city,
          state: cityStateZipParts.state,
          zip: cityStateZipParts.zip,
          error: row.error,
        };
      });

      setContractFetchRows(fetchedRows);
      setContractScanRows(scannedRows);
      setContractTermsByCsgId(toContractTermsFromScan(scannedRows));

      toast.success(
        `Contract scan completed. ${snapshot.result?.successCount ?? 0} success, ${snapshot.result?.failureCount ?? 0} failed.`
      );
      return;
    }

    if (snapshot.status === "failed") {
      setActiveScanJobId(null);
      toast.error(`Contract scan failed: ${snapshot.error ?? "Unknown job error."}`);
    }
  }, [scanJobQuery.data, activeScanJobId]);

  const invoiceMapHeaderDetection = useMemo(() => {
    if (!invoiceMapParsed) return { csgIdHeader: null, invoiceNumberHeader: null };
    return detectInvoiceNumberMapHeaders(invoiceMapParsed.headers);
  }, [invoiceMapParsed]);

  useEffect(() => {
    if (!invoiceMapParsed) return;
    setInvoiceMapHeaderSelection((current) => ({
      csgIdHeader: current.csgIdHeader ?? invoiceMapHeaderDetection.csgIdHeader,
      invoiceNumberHeader: current.invoiceNumberHeader ?? invoiceMapHeaderDetection.invoiceNumberHeader,
    }));
  }, [invoiceMapHeaderDetection, invoiceMapParsed]);

  const invoiceNumberMapRowsFromParsed = useMemo(() => {
    if (!invoiceMapParsed) return [] as InvoiceNumberMapRow[];
    try {
      return parseInvoiceNumberMap(invoiceMapParsed, {
        csgIdHeader: invoiceMapHeaderSelection.csgIdHeader,
        invoiceNumberHeader: invoiceMapHeaderSelection.invoiceNumberHeader,
      });
    } catch {
      return [];
    }
  }, [invoiceMapHeaderSelection.csgIdHeader, invoiceMapHeaderSelection.invoiceNumberHeader, invoiceMapParsed]);

  const invoiceNumberMapRows = useMemo(() => {
    if (invoiceMapParsed) return invoiceNumberMapRowsFromParsed;
    return savedInvoiceNumberMapRows;
  }, [invoiceMapParsed, invoiceNumberMapRowsFromParsed, savedInvoiceNumberMapRows]);

  useEffect(() => {
    if (!invoiceMapParsed) return;
    setSavedInvoiceNumberMapRows(invoiceNumberMapRowsFromParsed);
  }, [invoiceMapParsed, invoiceNumberMapRowsFromParsed]);

  const knownSystemIds = useMemo(() => {
    const set = new Set<string>();
    utilityRows.forEach((row) => set.add(row.systemId));
    csgSystemMappings.forEach((row) => {
      if (row.systemId) set.add(row.systemId);
    });
    return set;
  }, [utilityRows, csgSystemMappings]);

  const invoiceNumberToSystemId = useMemo(() => {
    if (!invoiceNumberMapRows.length) return undefined;
    return buildInvoiceNumberToSystemIdMap({
      invoiceNumberMapRows,
      csgSystemMappings,
    });
  }, [invoiceNumberMapRows, csgSystemMappings]);

  const quickBooksLedger = useMemo(() => {
    if (quickBooksByInvoice.size === 0) {
      return {
        bySystemId: new Map(),
        unmatchedLines: [],
      };
    }

    return buildQuickBooksPaidUpfrontLedger({
      quickBooksByInvoice,
      knownSystemIds,
      invoiceNumberToSystemId,
    });
  }, [quickBooksByInvoice, knownSystemIds, invoiceNumberToSystemId]);

  const csgBySystemId = useMemo(() => {
    const map = new Map<string, string>();
    csgSystemMappings.forEach((row) => {
      if (!row.systemId || !row.csgId) return;
      if (!map.has(row.systemId)) map.set(row.systemId, row.csgId);
    });
    return map;
  }, [csgSystemMappings]);

  const derivedScanIds = useMemo(() => {
    return Array.from(
      new Set(
        utilityRows
          .map((row) => csgBySystemId.get(row.systemId) ?? "")
          .map((value) => value.trim())
          .filter(Boolean)
      )
    ).sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
  }, [utilityRows, csgBySystemId]);

  const selectedScanIds = useMemo(() => {
    const manual = parseCsgIds(manualScanIdInput);
    return manual.length > 0 ? manual : derivedScanIds;
  }, [manualScanIdInput, derivedScanIds]);

  const computationResult = useMemo(() => {
    if (utilityRows.length === 0 || csgSystemMappings.length === 0 || projectApplications.length === 0) {
      return null;
    }

    return computeSettlementRows({
      utilityRows,
      csgSystemMappings,
      projectApplications,
      quickBooksPaidUpfrontLedger: quickBooksLedger,
      contractTermsByCsgId,
      previousCarryforwardBySystemId,
      manualOverridesByRowId,
    });
  }, [
    utilityRows,
    csgSystemMappings,
    projectApplications,
    quickBooksLedger,
    contractTermsByCsgId,
    previousCarryforwardBySystemId,
    manualOverridesByRowId,
  ]);

  const savedRuns = (savedRunsQuery.data ?? []) as RunSummary[];

  const missingRequiredInputs = useMemo(() => {
    const missing: string[] = [];
    if (utilityRows.length === 0) missing.push("Utility invoice file(s)");
    if (csgSystemMappings.length === 0) missing.push("CSG ↔ System mapping file");
    if (quickBooksByInvoice.size === 0) missing.push("QuickBooks detailed invoice report");
    if (projectApplications.length === 0) missing.push("ProjectApplication report");
    return missing;
  }, [utilityRows.length, csgSystemMappings.length, quickBooksByInvoice.size, projectApplications.length]);

  const handleUtilityUpload = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setIsUploadingUtility(true);

    try {
      const files = Array.from(fileList);
      const mergedRows: UtilityInvoiceRow[] = [];

      for (const file of files) {
        const rows = await parseUtilityInvoiceFile(file);
        mergedRows.push(...rows);
      }

      setUtilityRows(mergedRows);
      setRunInputs((current) => ({
        ...current,
        utilityInvoiceFiles: files.map((file) => file.name),
      }));
      toast.success(`Loaded ${mergedRows.length.toLocaleString("en-US")} utility rows from ${files.length} file(s).`);
    } catch (error) {
      toast.error(`Failed to parse utility invoice file(s): ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingUtility(false);
    }
  };

  const handleMappingUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setIsUploadingMapping(true);
    try {
      const parsed = await parseTabularFile(file);
      const rows = parseCsgSystemMapping(parsed);
      setCsgSystemMappings(rows);
      setRunInputs((current) => ({ ...current, csgSystemMappingFile: file.name }));
      toast.success(`Loaded ${rows.length.toLocaleString("en-US")} CSG/System ID mappings.`);
    } catch (error) {
      toast.error(`Failed to parse CSG/System mapping: ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingMapping(false);
    }
  };

  const handleQuickBooksUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setIsUploadingQuickBooks(true);
    try {
      const parsed = await parseTabularFile(file);
      const rows = parseQuickBooksDetailedReport(parsed);
      setQuickBooksByInvoice(rows);
      setRunInputs((current) => ({ ...current, quickBooksFile: file.name }));
      toast.success(`Loaded ${rows.size.toLocaleString("en-US")} QuickBooks invoices.`);
    } catch (error) {
      toast.error(`Failed to parse QuickBooks report: ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingQuickBooks(false);
    }
  };

  const handleProjectApplicationUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setIsUploadingProjectApps(true);
    try {
      const parsed = await parseTabularFile(file);
      const rows = parseProjectApplications(parsed);
      setProjectApplications(rows);
      setRunInputs((current) => ({ ...current, projectApplicationFile: file.name }));
      toast.success(`Loaded ${rows.length.toLocaleString("en-US")} ProjectApplication rows.`);
    } catch (error) {
      toast.error(`Failed to parse ProjectApplication file: ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingProjectApps(false);
    }
  };

  const handleInvoiceMapUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setIsUploadingInvoiceMap(true);
    try {
      const parsed = await parseTabularFile(file);
      const detection = detectInvoiceNumberMapHeaders(parsed.headers);
      setInvoiceMapParsed(parsed);
      setInvoiceMapHeaderSelection({
        csgIdHeader: detection.csgIdHeader,
        invoiceNumberHeader: detection.invoiceNumberHeader,
      });
      try {
        setSavedInvoiceNumberMapRows(
          parseInvoiceNumberMap(parsed, {
            csgIdHeader: detection.csgIdHeader,
            invoiceNumberHeader: detection.invoiceNumberHeader,
          })
        );
      } catch {
        setSavedInvoiceNumberMapRows([]);
      }
      setRunInputs((current) => ({ ...current, portalInvoiceMapFile: file.name }));
      toast.success(`Loaded portal invoice map file (${parsed.rows.length.toLocaleString("en-US")} rows).`);
    } catch (error) {
      toast.error(`Failed to parse optional invoice map file: ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingInvoiceMap(false);
    }
  };

  const handleSavePortalCredentials = async () => {
    try {
      await savePortalCredentialsMutation.mutateAsync({
        email: clean(portalEmail) || undefined,
        password: clean(portalPassword) || undefined,
        baseUrl: clean(portalBaseUrl) || undefined,
      });
      setPortalPassword("");
      await trpcUtils.csgPortal.status.invalidate();
      toast.success("CSG portal credentials saved.");
    } catch (error) {
      toast.error(`Failed to save credentials: ${toErrorMessage(error)}`);
    }
  };

  const handleTestPortalConnection = async () => {
    try {
      await testPortalConnectionMutation.mutateAsync({
        email: clean(portalEmail) || undefined,
        password: clean(portalPassword) || undefined,
        baseUrl: clean(portalBaseUrl) || undefined,
      });
      setPortalPassword("");
      await trpcUtils.csgPortal.status.invalidate();
      toast.success("CSG portal connection succeeded.");
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  };

  const handleStartContractScan = async () => {
    if (selectedScanIds.length === 0) {
      toast.error("No CSG IDs available to scan.");
      return;
    }

    try {
      const started = await startScanJobMutation.mutateAsync({
        csgIds: selectedScanIds,
        email: clean(portalEmail) || undefined,
        password: clean(portalPassword) || undefined,
        baseUrl: clean(portalBaseUrl) || undefined,
      });
      setActiveScanJobId(started.jobId);
      toast.success(`Started contract scan for ${selectedScanIds.length.toLocaleString("en-US")} CSG IDs.`);
    } catch (error) {
      toast.error(`Could not start contract scan: ${toErrorMessage(error)}`);
    }
  };

  const handleExportCsv = () => {
    if (!computationResult || computationResult.rows.length === 0) {
      toast.error("No computed rows are available to export.");
      return;
    }

    const csv = buildSettlementCsv(computationResult.rows);
    const safeMonth = clean(monthKey) || buildMonthKey();
    downloadTextFile(`abp-invoice-settlement-${safeMonth}.csv`, csv, "text/csv;charset=utf-8");
    toast.success("CSV exported.");
  };

  const handleSaveRun = async () => {
    if (!computationResult) {
      toast.error("Load required files first so the run can be saved.");
      return;
    }

    const payload: SavedRunPayload = {
      version: 1,
      monthKey: clean(monthKey) || buildMonthKey(),
      label: clean(runLabel) || null,
      savedAt: new Date().toISOString(),
      runInputs,
      utilityRows,
      csgSystemMappings,
      projectApplications: serializeProjectApplications(projectApplications),
      quickBooksInvoices: serializeQuickBooksInvoices(quickBooksByInvoice),
      invoiceNumberMapRows,
      contractTerms: Array.from(contractTermsByCsgId.values()),
      manualOverridesByRowId,
      previousCarryforwardBySystemId,
      computedRows: computationResult.rows,
      warnings: computationResult.warnings,
      carryforwardBySystemId: computationResult.carryforwardBySystemId,
    };

    try {
      const response = await saveRunMutation.mutateAsync({
        monthKey: payload.monthKey,
        label: payload.label ?? undefined,
        payload: JSON.stringify(payload),
        rowCount: computationResult.rows.length,
      });
      await trpcUtils.abpSettlement.listRuns.invalidate();
      toast.success(`Run saved (${response.runId}).`);
    } catch (error) {
      toast.error(`Could not save run: ${toErrorMessage(error)}`);
    }
  };

  const applyLoadedRun = (payload: SavedRunPayload) => {
    setMonthKey(payload.monthKey || buildMonthKey());
    setRunLabel(payload.label ?? "");
    setRunInputs(payload.runInputs);
    setUtilityRows(payload.utilityRows ?? []);
    setCsgSystemMappings(payload.csgSystemMappings ?? []);
    setProjectApplications(deserializeProjectApplications(payload.projectApplications ?? []));
    setQuickBooksByInvoice(deserializeQuickBooksInvoices(payload.quickBooksInvoices ?? []));
    setInvoiceMapParsed(null);
    setInvoiceMapHeaderSelection({ csgIdHeader: null, invoiceNumberHeader: null });
    setSavedInvoiceNumberMapRows(payload.invoiceNumberMapRows ?? []);
    setContractTermsByCsgId(new Map((payload.contractTerms ?? []).map((term) => [term.csgId, term])));
    setContractScanRows(
      (payload.contractTerms ?? []).map((term) => ({
        csgId: term.csgId,
        fileName: term.fileName,
        ccAuthorizationCompleted: term.ccAuthorizationCompleted,
        ccCardAsteriskCount: term.ccCardAsteriskCount,
        additionalFivePercentSelected: null,
        additionalCollateralPercent: term.additionalCollateralPercent,
        vendorFeePercent: term.vendorFeePercent,
        recQuantity: term.recQuantity,
        recPrice: term.recPrice,
        paymentMethod: term.paymentMethod ?? null,
        payeeName: term.payeeName ?? null,
        mailingAddress1: term.mailingAddress1 ?? null,
        mailingAddress2: term.mailingAddress2 ?? null,
        cityStateZip: term.cityStateZip ?? null,
        city: term.city ?? null,
        state: term.state ?? null,
        zip: term.zip ?? null,
        error: null,
      }))
    );
    setManualOverridesByRowId(payload.manualOverridesByRowId ?? {});
    setPreviousCarryforwardBySystemId(payload.carryforwardBySystemId ?? payload.previousCarryforwardBySystemId ?? {});
  };

  const handleLoadRun = async (runId: string) => {
    setLoadingRunId(runId);
    try {
      const response = await trpcUtils.abpSettlement.getRun.fetch({ runId });
      const parsed = JSON.parse(response.payload) as SavedRunPayload;
      if (!parsed || parsed.version !== 1) {
        throw new Error("Saved run payload has an unsupported format.");
      }
      applyLoadedRun(parsed);
      toast.success(`Loaded saved run ${runId}.`);
    } catch (error) {
      toast.error(`Could not load run ${runId}: ${toErrorMessage(error)}`);
    } finally {
      setLoadingRunId(null);
    }
  };

  const handleSeedCarryforwardFromRun = async (runId: string) => {
    setLoadingRunId(runId);
    try {
      const response = await trpcUtils.abpSettlement.getRun.fetch({ runId });
      const parsed = JSON.parse(response.payload) as SavedRunPayload;
      const carryforward = parsed.carryforwardBySystemId ?? {};
      setPreviousCarryforwardBySystemId(carryforward);
      toast.success(
        `Loaded carryforward seed from ${runId} (${Object.keys(carryforward).length.toLocaleString("en-US")} systems).`
      );
    } catch (error) {
      toast.error(`Could not load carryforward seed from ${runId}: ${toErrorMessage(error)}`);
    } finally {
      setLoadingRunId(null);
    }
  };

  const updateOverride = (rowId: string, patch: Partial<ManualOverride>) => {
    setManualOverridesByRowId((current) => {
      const existing = current[rowId] ?? {};
      const next = { ...existing, ...patch };
      const hasValue =
        next.classification !== undefined ||
        next.carryforwardIn !== undefined ||
        next.vendorFeePercent !== undefined ||
        next.additionalCollateralPercent !== undefined ||
        next.applicationFeeAmount !== undefined ||
        clean(next.notes).length > 0;

      if (!hasValue) {
        const copy = { ...current };
        delete copy[rowId];
        return copy;
      }

      return {
        ...current,
        [rowId]: next,
      };
    });
  };

  const clearAllState = () => {
    setRunInputs({
      utilityInvoiceFiles: [],
      csgSystemMappingFile: null,
      quickBooksFile: null,
      projectApplicationFile: null,
      portalInvoiceMapFile: null,
    });
    setUtilityRows([]);
    setCsgSystemMappings([]);
    setProjectApplications([]);
    setQuickBooksByInvoice(new Map());
    setInvoiceMapParsed(null);
    setInvoiceMapHeaderSelection({ csgIdHeader: null, invoiceNumberHeader: null });
    setSavedInvoiceNumberMapRows([]);
    setManualOverridesByRowId({});
    setPreviousCarryforwardBySystemId({});
    setContractFetchRows([]);
    setContractScanRows([]);
    setContractTermsByCsgId(new Map());
    setManualScanIdInput("");
    setActiveScanJobId(null);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) return null;

  const scanProgress = scanJobQuery.data?.progress;
  const scanInFlight = Boolean(activeScanJobId);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50">
      <header className="border-b bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">ABP Monthly Invoice Settlement</h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload monthly files, scan CSG portal contracts, calculate withholdings/carryforward, then export payout-ready rows.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Run Setup</CardTitle>
            <CardDescription>
              Set the run month and optional label. Save and load runs for month-to-month continuity.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="month-key">Run Month (YYYY-MM)</Label>
                <Input
                  id="month-key"
                  value={monthKey}
                  onChange={(event) => setMonthKey(event.target.value)}
                  placeholder="2026-03"
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="run-label">Run Label (optional)</Label>
                <Input
                  id="run-label"
                  value={runLabel}
                  onChange={(event) => setRunLabel(event.target.value)}
                  placeholder="March utility settlement"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={handleSaveRun}
                disabled={saveRunMutation.isPending || !computationResult}
              >
                {saveRunMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Save Run
              </Button>
              <Button variant="outline" onClick={clearAllState}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Clear Current State
              </Button>
              <Badge variant="secondary">
                {computationResult?.rows.length.toLocaleString("en-US") ?? "0"} computed row(s)
              </Badge>
              <Badge variant="secondary">
                {Object.keys(previousCarryforwardBySystemId).length.toLocaleString("en-US")} carryforward seed(s)
              </Badge>
            </div>

            <div className="rounded-md border">
              <div className="max-h-56 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Run ID</TableHead>
                      <TableHead>Month</TableHead>
                      <TableHead>Label</TableHead>
                      <TableHead>Rows</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!savedRuns.length ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-sm text-slate-500 text-center py-6">
                          No saved runs yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      savedRuns.map((run) => (
                        <TableRow key={run.runId}>
                          <TableCell className="font-mono text-xs">{run.runId}</TableCell>
                          <TableCell>{run.monthKey}</TableCell>
                          <TableCell>{run.label ?? ""}</TableCell>
                          <TableCell>{run.rowCount ?? ""}</TableCell>
                          <TableCell>{formatDateTime(run.updatedAt)}</TableCell>
                          <TableCell className="text-right space-x-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleLoadRun(run.runId)}
                              disabled={loadingRunId === run.runId}
                            >
                              {loadingRunId === run.runId ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                              ) : null}
                              Load
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleSeedCarryforwardFromRun(run.runId)}
                              disabled={loadingRunId === run.runId}
                            >
                              Seed Carryforward
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) Upload Inputs</CardTitle>
            <CardDescription>
              Required: utility invoices, CSG/System mapping, QuickBooks report, and ProjectApplication file. Optional: portal invoice map.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="utility-upload">Utility Invoice Workbooks (.xlsx/.csv, multi-file)</Label>
                <Input
                  id="utility-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  multiple
                  onChange={(event) => {
                    void handleUtilityUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingUtility}
                />
                <div className="text-xs text-slate-600">
                  {runInputs.utilityInvoiceFiles.length > 0
                    ? `${runInputs.utilityInvoiceFiles.length} file(s) loaded.`
                    : "No utility files loaded."}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="mapping-upload">CSG ↔ System ID Mapping (.csv/.xlsx)</Label>
                <Input
                  id="mapping-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  onChange={(event) => {
                    void handleMappingUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingMapping}
                />
                <div className="text-xs text-slate-600">
                  {runInputs.csgSystemMappingFile ?? "No mapping file loaded."}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="quickbooks-upload">QuickBooks Detailed Invoice Report</Label>
                <Input
                  id="quickbooks-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  onChange={(event) => {
                    void handleQuickBooksUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingQuickBooks}
                />
                <div className="text-xs text-slate-600">
                  {runInputs.quickBooksFile ?? "No QuickBooks file loaded."}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-app-upload">ProjectApplication CSV</Label>
                <Input
                  id="project-app-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  onChange={(event) => {
                    void handleProjectApplicationUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingProjectApps}
                />
                <div className="text-xs text-slate-600">
                  {runInputs.projectApplicationFile ?? "No ProjectApplication file loaded."}
                </div>
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="invoice-map-upload">Optional Portal Invoice Map (CSG ID ↔ Invoice Number)</Label>
                <Input
                  id="invoice-map-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  onChange={(event) => {
                    void handleInvoiceMapUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingInvoiceMap}
                />
                <div className="text-xs text-slate-600">
                  {runInputs.portalInvoiceMapFile ?? "No optional invoice map loaded."}
                </div>
              </div>
            </div>

            {invoiceMapParsed ? (
              <div className="rounded-md border p-4 space-y-3">
                <div className="text-sm font-medium">Invoice Map Header Selection</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>CSG ID Header</Label>
                    <Select
                      value={invoiceMapHeaderSelection.csgIdHeader ?? ""}
                      onValueChange={(value) =>
                        setInvoiceMapHeaderSelection((current) => ({
                          ...current,
                          csgIdHeader: value || null,
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select CSG ID header" />
                      </SelectTrigger>
                      <SelectContent>
                        {invoiceMapParsed.headers.map((header) => (
                          <SelectItem key={header} value={header}>
                            {header}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Invoice Number Header</Label>
                    <Select
                      value={invoiceMapHeaderSelection.invoiceNumberHeader ?? ""}
                      onValueChange={(value) =>
                        setInvoiceMapHeaderSelection((current) => ({
                          ...current,
                          invoiceNumberHeader: value || null,
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select invoice number header" />
                      </SelectTrigger>
                      <SelectContent>
                        {invoiceMapParsed.headers.map((header) => (
                          <SelectItem key={header} value={header}>
                            {header}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="text-xs text-slate-600">
                  Parsed {invoiceNumberMapRows.length.toLocaleString("en-US")} invoice-map rows.
                </div>
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-md border p-3 text-sm">
                <div className="font-medium mb-1">Input Counts</div>
                <div>Utility rows: {utilityRows.length.toLocaleString("en-US")}</div>
                <div>CSG/System mappings: {csgSystemMappings.length.toLocaleString("en-US")}</div>
                <div>QuickBooks invoices: {quickBooksByInvoice.size.toLocaleString("en-US")}</div>
                <div>ProjectApplication rows: {projectApplications.length.toLocaleString("en-US")}</div>
                <div>Invoice map rows: {invoiceNumberMapRows.length.toLocaleString("en-US")}</div>
              </div>
              <div className="rounded-md border p-3 text-sm">
                <div className="font-medium mb-1">QuickBooks Allocation</div>
                <div>
                  Matched system lines: {Array.from(quickBooksLedger.bySystemId.values())
                    .reduce((acc, row) => acc + row.matchedLines.length, 0)
                    .toLocaleString("en-US")}
                </div>
                <div>
                  Collateral reimbursement to partner company: {formatCurrency(
                    Array.from(quickBooksLedger.bySystemId.values()).reduce(
                      (acc, row) =>
                        acc + (row.utilityCollateralReimbursementToPartnerCompanyAmount ?? 0),
                      0
                    )
                  )}
                </div>
                <div>
                  Unmatched category lines: {quickBooksLedger.unmatchedLines.length.toLocaleString("en-US")}
                </div>
              </div>
            </div>

            {missingRequiredInputs.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Missing required inputs: {missingRequiredInputs.join(", ")}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3) CSG Portal Contract Scan</CardTitle>
            <CardDescription>
              Save/test portal credentials, then scan the top Rec Contract PDF for each CSG ID.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="portal-email">Portal Email</Label>
                <Input
                  id="portal-email"
                  type="email"
                  value={portalEmail}
                  onChange={(event) => setPortalEmail(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="portal-password">Portal Password</Label>
                <Input
                  id="portal-password"
                  type="password"
                  value={portalPassword}
                  onChange={(event) => setPortalPassword(event.target.value)}
                  placeholder={csgPortalStatusQuery.data?.hasPassword ? "Saved password on file" : "Enter password"}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="portal-base-url">Portal Base URL</Label>
                <Input
                  id="portal-base-url"
                  value={portalBaseUrl}
                  onChange={(event) => setPortalBaseUrl(event.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={handleSavePortalCredentials}
                disabled={savePortalCredentialsMutation.isPending}
              >
                {savePortalCredentialsMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Save Credentials
              </Button>
              <Button
                variant="outline"
                onClick={handleTestPortalConnection}
                disabled={testPortalConnectionMutation.isPending}
              >
                {testPortalConnectionMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Test Connection
              </Button>
              <Badge variant={csgPortalStatusQuery.data?.connected ? "default" : "secondary"}>
                {csgPortalStatusQuery.data?.connected ? "Connected" : "Not connected"}
              </Badge>
              {csgPortalStatusQuery.data?.lastTestStatus ? (
                <Badge variant="secondary">
                  Last test: {csgPortalStatusQuery.data.lastTestStatus} {formatDateTime(csgPortalStatusQuery.data.lastTestedAt)}
                </Badge>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="manual-scan-ids">
                CSG IDs to Scan (optional override; comma/newline separated)
              </Label>
              <Textarea
                id="manual-scan-ids"
                value={manualScanIdInput}
                onChange={(event) => setManualScanIdInput(event.target.value)}
                placeholder="Leave blank to scan all IDs from uploaded utility rows + mapping"
                rows={3}
              />
              <div className="text-xs text-slate-600">
                Selected scan IDs: {selectedScanIds.length.toLocaleString("en-US")}
                {manualScanIdInput.trim().length === 0 && derivedScanIds.length > 0 ? " (derived automatically)" : ""}
              </div>
            </div>

            <div>
              <Button
                onClick={handleStartContractScan}
                disabled={scanInFlight || startScanJobMutation.isPending || selectedScanIds.length === 0}
              >
                {scanInFlight || startScanJobMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Start Contract Scan
              </Button>
            </div>

            {scanInFlight && scanProgress ? (
              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>{scanProgress.message}</span>
                  <span>
                    {scanProgress.current}/{scanProgress.total}
                  </span>
                </div>
                <Progress value={scanProgress.percent} />
                <div className="text-xs text-slate-500">Current CSG ID: {scanProgress.currentCsgId ?? "-"}</div>
              </div>
            ) : null}

            <div className="rounded-md border">
              <div className="max-h-64 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>CSG ID</TableHead>
                      <TableHead>PDF</TableHead>
                      <TableHead>Vendor Fee %</TableHead>
                      <TableHead>Additional Collateral %</TableHead>
                      <TableHead>CC Auth</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contractScanRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-sm text-slate-500 text-center py-6">
                          No scan rows yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      contractScanRows.map((row) => (
                        <TableRow key={`${row.csgId}:${row.fileName}`}>
                          <TableCell>{row.csgId}</TableCell>
                          <TableCell className="max-w-[240px] truncate" title={row.fileName}>
                            {row.fileName}
                          </TableCell>
                          <TableCell>{formatPercent(row.vendorFeePercent)}</TableCell>
                          <TableCell>{formatPercent(row.additionalCollateralPercent)}</TableCell>
                          <TableCell>
                            {row.ccAuthorizationCompleted === null
                              ? "Unknown"
                              : row.ccAuthorizationCompleted
                                ? `Completed${row.ccCardAsteriskCount ? ` (${row.ccCardAsteriskCount})` : ""}`
                                : "Incomplete"}
                          </TableCell>
                          <TableCell className="text-red-600">{row.error ?? ""}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>4) Settlement Output</CardTitle>
              <CardDescription>
                Includes first/only-payment formula columns plus classification, carryforward, confidence flags, and override notes.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={handleExportCsv} disabled={!computationResult || computationResult.rows.length === 0}>
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {computationResult?.warnings.length ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-1 text-sm text-amber-900">
                {computationResult.warnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-md border p-3 text-sm">
                <div className="text-slate-500">Rows</div>
                <div className="text-lg font-semibold">{computationResult?.rows.length ?? 0}</div>
              </div>
              <div className="rounded-md border p-3 text-sm">
                <div className="text-slate-500">Unknown Classification</div>
                <div className="text-lg font-semibold">
                  {computationResult?.rows.filter((row) => row.classification === "unknown").length ?? 0}
                </div>
              </div>
              <div className="rounded-md border p-3 text-sm">
                <div className="text-slate-500">Contract Terms Loaded</div>
                <div className="text-lg font-semibold">{contractTermsByCsgId.size}</div>
              </div>
              <div className="rounded-md border p-3 text-sm">
                <div className="text-slate-500">Carryforward Systems</div>
                <div className="text-lg font-semibold">
                  {Object.keys(computationResult?.carryforwardBySystemId ?? {}).length}
                </div>
              </div>
            </div>

            {!computationResult ? (
              <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600">
                <Upload className="mx-auto mb-3 h-5 w-5 text-slate-500" />
                Upload required files to compute settlement rows.
              </div>
            ) : (
              <div className="rounded-md border">
                <div className="max-h-[72vh] overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-white z-10">
                      <TableRow>
                        <TableHead>CSG ID</TableHead>
                        <TableHead>System ID</TableHead>
                        <TableHead>Invoice Amount</TableHead>
                        <TableHead>REC Quantity</TableHead>
                        <TableHead>REC Price</TableHead>
                        <TableHead>Gross Contract Value</TableHead>
                        <TableHead>Payment #</TableHead>
                        <TableHead>Vendor Fee %</TableHead>
                        <TableHead>Vendor Fee Amount</TableHead>
                        <TableHead>Utility Held Collateral 5% Amount</TableHead>
                        <TableHead>Utility Held Collateral Paid Upfront</TableHead>
                        <TableHead>Collateral Reimbursement to the Partner Company</TableHead>
                        <TableHead>Application Fee Amount</TableHead>
                        <TableHead>Application Fee Paid Upfront</TableHead>
                        <TableHead>Additional Collateral %</TableHead>
                        <TableHead>Additional Collateral Amount</TableHead>
                        <TableHead>CC Authorization Form Status</TableHead>
                        <TableHead>CC Incomplete 5% Required</TableHead>
                        <TableHead>First Payment Formula Net</TableHead>
                        <TableHead>Payment Method</TableHead>
                        <TableHead>Payee Name</TableHead>
                        <TableHead>Mailing Address 1</TableHead>
                        <TableHead>Mailing Address 2</TableHead>
                        <TableHead>City</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Zip</TableHead>
                        <TableHead>Classification</TableHead>
                        <TableHead>Carryforward In</TableHead>
                        <TableHead>Carryforward Out</TableHead>
                        <TableHead>Confidence Flags</TableHead>
                        <TableHead>Override Classification</TableHead>
                        <TableHead>Override Carryforward In</TableHead>
                        <TableHead>Override Vendor Fee %</TableHead>
                        <TableHead>Override Addl Collateral %</TableHead>
                        <TableHead>Override App Fee</TableHead>
                        <TableHead>Override Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {computationResult.rows.map((row) => {
                        const override = manualOverridesByRowId[row.rowId] ?? {};
                        return (
                          <TableRow key={row.rowId}>
                            <TableCell>{row.csgId ?? ""}</TableCell>
                            <TableCell>{row.systemId}</TableCell>
                            <TableCell>{formatCurrency(row.invoiceAmount)}</TableCell>
                            <TableCell>{row.recQuantity}</TableCell>
                            <TableCell>{formatCurrency(row.recPrice)}</TableCell>
                            <TableCell>{formatCurrency(row.grossContractValue)}</TableCell>
                            <TableCell>{row.paymentNumber ?? ""}</TableCell>
                            <TableCell>{formatPercent(row.vendorFeePercent)}</TableCell>
                            <TableCell>{formatCurrency(row.vendorFeeAmount)}</TableCell>
                            <TableCell>{formatCurrency(row.utilityHeldCollateral5PercentAmount)}</TableCell>
                            <TableCell>{formatCurrency(row.utilityHeldCollateralPaidUpfront)}</TableCell>
                            <TableCell>{formatCurrency(row.collateralReimbursementToPartnerCompanyAmount)}</TableCell>
                            <TableCell>{formatCurrency(row.applicationFeeAmount)}</TableCell>
                            <TableCell>{formatCurrency(row.applicationFeePaidUpfront)}</TableCell>
                            <TableCell>{formatPercent(row.additionalCollateralPercent)}</TableCell>
                            <TableCell>{formatCurrency(row.additionalCollateralAmount)}</TableCell>
                            <TableCell>{row.ccAuthorizationFormStatus}</TableCell>
                            <TableCell>{formatCurrency(row.ccAuthIncomplete5PercentAmount)}</TableCell>
                            <TableCell>{formatCurrency(row.firstPaymentFormulaNetAmount)}</TableCell>
                            <TableCell>{row.paymentMethod}</TableCell>
                            <TableCell>{row.payeeName}</TableCell>
                            <TableCell>{row.mailingAddress1}</TableCell>
                            <TableCell>{row.mailingAddress2}</TableCell>
                            <TableCell>{row.city}</TableCell>
                            <TableCell>{row.state}</TableCell>
                            <TableCell>{row.zip}</TableCell>
                            <TableCell>{row.classification}</TableCell>
                            <TableCell>{formatCurrency(row.carryforwardIn)}</TableCell>
                            <TableCell>{formatCurrency(row.carryforwardOut)}</TableCell>
                            <TableCell className="max-w-[240px]">
                              <div className="text-xs whitespace-pre-wrap">
                                {row.confidenceFlags.join(" | ")}
                              </div>
                            </TableCell>
                            <TableCell className="min-w-[180px]">
                              <Select
                                value={override.classification ?? "__auto__"}
                                onValueChange={(value) => {
                                  const classification =
                                    value === "__auto__"
                                      ? undefined
                                      : isClassification(value)
                                        ? value
                                        : undefined;
                                  updateOverride(row.rowId, { classification });
                                }}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Auto" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__auto__">Auto</SelectItem>
                                  <SelectItem value="first_full_upfront">first_full_upfront</SelectItem>
                                  <SelectItem value="first_partial">first_partial</SelectItem>
                                  <SelectItem value="quarterly">quarterly</SelectItem>
                                  <SelectItem value="unknown">unknown</SelectItem>
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="min-w-[140px]">
                              <Input
                                type="number"
                                step="0.01"
                                value={override.carryforwardIn ?? ""}
                                onChange={(event) =>
                                  updateOverride(row.rowId, {
                                    carryforwardIn: parseNumberInput(event.target.value),
                                  })
                                }
                              />
                            </TableCell>
                            <TableCell className="min-w-[140px]">
                              <Input
                                type="number"
                                step="0.01"
                                value={override.vendorFeePercent ?? ""}
                                onChange={(event) =>
                                  updateOverride(row.rowId, {
                                    vendorFeePercent: parseNumberInput(event.target.value),
                                  })
                                }
                              />
                            </TableCell>
                            <TableCell className="min-w-[160px]">
                              <Input
                                type="number"
                                step="0.01"
                                value={override.additionalCollateralPercent ?? ""}
                                onChange={(event) =>
                                  updateOverride(row.rowId, {
                                    additionalCollateralPercent: parseNumberInput(event.target.value),
                                  })
                                }
                              />
                            </TableCell>
                            <TableCell className="min-w-[140px]">
                              <Input
                                type="number"
                                step="0.01"
                                value={override.applicationFeeAmount ?? ""}
                                onChange={(event) =>
                                  updateOverride(row.rowId, {
                                    applicationFeeAmount: parseNumberInput(event.target.value),
                                  })
                                }
                              />
                            </TableCell>
                            <TableCell className="min-w-[220px]">
                              <Textarea
                                value={override.notes ?? ""}
                                onChange={(event) =>
                                  updateOverride(row.rowId, {
                                    notes: event.target.value,
                                  })
                                }
                                rows={2}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {contractFetchRows.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Contract Fetch Audit</CardTitle>
              <CardDescription>Per-CSG fetch outcomes from portal download.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border">
                <div className="max-h-56 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>CSG ID</TableHead>
                        <TableHead>System Page</TableHead>
                        <TableHead>PDF URL</TableHead>
                        <TableHead>Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contractFetchRows.map((row) => (
                        <TableRow key={`${row.csgId}:${row.systemPageUrl}`}>
                          <TableCell>{row.csgId}</TableCell>
                          <TableCell className="max-w-[260px] truncate" title={row.systemPageUrl}>
                            {row.systemPageUrl}
                          </TableCell>
                          <TableCell className="max-w-[260px] truncate" title={row.pdfUrl ?? ""}>
                            {row.pdfUrl ?? ""}
                          </TableCell>
                          <TableCell className="text-red-600">{row.error ?? ""}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </main>
    </div>
  );
}
