import { useAuth } from "@/_core/hooks/useAuth";
import { extractContractDataFromPdf, type ContractExtraction } from "@/lib/contractScanner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Download, Loader2, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type ContractExtractionRow = ContractExtraction & {
  id: string;
  processedAt: string;
  error: string | null;
};

const formatBoolean = (value: boolean | null): string => {
  if (value === null) return "";
  return value ? "Yes" : "No";
};

const formatNumber = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return "";
  return String(value);
};

const formatCurrency = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return "";
  return value.toFixed(2);
};

const formatTimestamp = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US");
};

const splitCityStateZip = (
  cityStateZip: string | null
): { city: string; state: string; zip: string } => {
  const raw = (cityStateZip ?? "").trim();
  if (!raw) {
    return { city: "", state: "", zip: "" };
  }

  const normalized = raw.replace(/\s+/g, " ");
  const fullMatch = normalized.match(/^(.+?)[,\s]+([A-Za-z]{2,})\s+(\d{5}(?:-\d{4})?)$/);
  if (!fullMatch) {
    return { city: normalized, state: "", zip: "" };
  }

  const city = fullMatch[1].trim();
  const stateRaw = fullMatch[2].trim();
  const zip = fullMatch[3].trim();

  return {
    city,
    state: stateRaw.length === 2 ? stateRaw.toUpperCase() : stateRaw,
    zip,
  };
};

const csvEscape = (value: string): string => `"${value.replace(/"/g, "\"\"")}"`;

const buildCsv = (rows: ContractExtractionRow[]): string => {
  const headers = [
    "File Name",
    "Processed At",
    "CC Authorization Completed",
    "Card Number Asterisks",
    "Additional 5% Box Checked",
    "Additional Collateral %",
    "Vendor Fee %",
    "System Name",
    "Payment Method",
    "Payee Name",
    "Mailing Address 1",
    "Mailing Address 2",
    "City",
    "State",
    "Zip",
    "REC Quantity",
    "REC Price",
    "AC Size (kW)",
    "DC Size (kW)",
    "Error",
  ];

  const lines = [headers.map(csvEscape).join(",")];

  for (const row of rows) {
    const cityStateZipParts = splitCityStateZip(row.cityStateZip);

    lines.push(
      [
        row.fileName,
        row.processedAt,
        formatBoolean(row.ccAuthorizationCompleted),
        formatNumber(row.ccCardAsteriskCount),
        formatBoolean(row.additionalFivePercentSelected),
        formatNumber(row.additionalCollateralPercent),
        formatNumber(row.vendorFeePercent),
        row.systemName ?? "",
        row.paymentMethod ?? "",
        row.payeeName ?? "",
        row.mailingAddress1 ?? "",
        row.mailingAddress2 ?? "",
        cityStateZipParts.city,
        cityStateZipParts.state,
        cityStateZipParts.zip,
        formatNumber(row.recQuantity),
        formatCurrency(row.recPrice),
        formatNumber(row.acSizeKw),
        formatNumber(row.dcSizeKw),
        row.error ?? "",
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  return lines.join("\n");
};

const createErrorRow = (file: File, message: string): ContractExtractionRow => ({
  id: crypto.randomUUID(),
  processedAt: new Date().toISOString(),
  error: message,
  fileName: file.name,
  ccAuthorizationCompleted: null,
  ccCardAsteriskCount: null,
  additionalFivePercentSelected: null,
  additionalCollateralPercent: null,
  vendorFeePercent: null,
  systemName: null,
  paymentMethod: null,
  payeeName: null,
  mailingAddress1: null,
  mailingAddress2: null,
  cityStateZip: null,
  recQuantity: null,
  recPrice: null,
  acSizeKw: null,
  dcSizeKw: null,
});

export default function ContractScanner() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [rows, setRows] = useState<ContractExtractionRow[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState("");

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, setLocation, user]);

  const successfulRows = useMemo(() => rows.filter((row) => !row.error), [rows]);

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList?.length) return;

    const files = Array.from(fileList).filter((file) => file.name.toLowerCase().endsWith(".pdf"));
    if (!files.length) {
      toast.error("Please upload at least one PDF file.");
      return;
    }

    setIsProcessing(true);

    let completed = 0;
    try {
      const nextRows: ContractExtractionRow[] = [];

      for (const file of files) {
        setProgressText(`Processing ${completed + 1} of ${files.length}: ${file.name}`);
        try {
          const parsed = await extractContractDataFromPdf(file);
          nextRows.push({
            ...parsed,
            id: crypto.randomUUID(),
            processedAt: new Date().toISOString(),
            error: null,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to parse PDF.";
          nextRows.push(createErrorRow(file, message));
        }
        completed += 1;
      }

      setRows((currentRows) => [...currentRows, ...nextRows]);
      const successCount = nextRows.filter((row) => !row.error).length;
      const errorCount = nextRows.length - successCount;
      const firstError = nextRows.find((row) => row.error)?.error ?? null;
      if (successCount > 0) {
        toast.success(`Parsed ${successCount} contract${successCount === 1 ? "" : "s"}.`);
      }
      if (errorCount > 0) {
        const detail = firstError ? ` First error: ${firstError}` : "";
        toast.error(`${errorCount} file${errorCount === 1 ? "" : "s"} could not be parsed.${detail}`);
      }
    } finally {
      setIsProcessing(false);
      setProgressText("");
    }
  };

  const handleExport = () => {
    if (!rows.length) {
      toast.error("No rows available to export.");
      return;
    }

    const csvText = buildCsv(rows);
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const dateStamp = new Date().toISOString().slice(0, 10);
    anchor.download = `contract-scan-results-${dateStamp}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50">
      <header className="border-b bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">Contract Scanner</h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload one or many contract PDFs, extract key fields, and export all results to CSV.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Upload Contracts</CardTitle>
            <CardDescription>
              Supports multiple PDF uploads. New scans are appended to the table below.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="contract-upload">Contract PDFs</Label>
              <input
                id="contract-upload"
                type="file"
                accept=".pdf,application/pdf"
                multiple
                className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 file:mr-4 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700"
                onChange={(event) => {
                  void handleUpload(event.target.files);
                  event.currentTarget.value = "";
                }}
                disabled={isProcessing}
              />
            </div>
            <div className="text-sm text-slate-600">
              Extracted fields include CC authorization status, collateral values, vendor fee, system details, payment details,
              and REC/system sizing fields from cover sheets.
            </div>
            {isProcessing && (
              <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <Loader2 className="h-4 w-4 animate-spin" />
                {progressText || "Processing files..."}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>2) Results</CardTitle>
              <CardDescription>
                {rows.length.toLocaleString()} total file{rows.length === 1 ? "" : "s"} processed,{" "}
                {successfulRows.length.toLocaleString()} successful parse{successfulRows.length === 1 ? "" : "s"}.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={handleExport} disabled={rows.length === 0}>
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
              <Button variant="outline" onClick={() => setRows([])} disabled={rows.length === 0 || isProcessing}>
                <Trash2 className="h-4 w-4 mr-2" />
                Clear
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600">
                <Upload className="mx-auto mb-3 h-5 w-5 text-slate-500" />
                No contracts scanned yet.
              </div>
            ) : (
              <div className="rounded-md border">
                <div className="max-h-[68vh] overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-white z-10">
                      <TableRow>
                        <TableHead>File</TableHead>
                        <TableHead>Processed</TableHead>
                        <TableHead>CC Form Complete</TableHead>
                        <TableHead>Card *</TableHead>
                        <TableHead>5% Box</TableHead>
                        <TableHead>Additional Collateral %</TableHead>
                        <TableHead>Vendor Fee %</TableHead>
                        <TableHead>System Name</TableHead>
                        <TableHead>Payment Method</TableHead>
                        <TableHead>Payee</TableHead>
                        <TableHead>Address 1</TableHead>
                        <TableHead>Address 2</TableHead>
                        <TableHead>City/State/Zip</TableHead>
                        <TableHead>REC Qty</TableHead>
                        <TableHead>REC Price</TableHead>
                        <TableHead>AC kW</TableHead>
                        <TableHead>DC kW</TableHead>
                        <TableHead>Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="font-medium whitespace-nowrap">{row.fileName}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{formatTimestamp(row.processedAt)}</TableCell>
                          <TableCell>{formatBoolean(row.ccAuthorizationCompleted)}</TableCell>
                          <TableCell>{formatNumber(row.ccCardAsteriskCount)}</TableCell>
                          <TableCell>{formatBoolean(row.additionalFivePercentSelected)}</TableCell>
                          <TableCell>{formatNumber(row.additionalCollateralPercent)}</TableCell>
                          <TableCell>{formatNumber(row.vendorFeePercent)}</TableCell>
                          <TableCell>{row.systemName ?? ""}</TableCell>
                          <TableCell>{row.paymentMethod ?? ""}</TableCell>
                          <TableCell>{row.payeeName ?? ""}</TableCell>
                          <TableCell>{row.mailingAddress1 ?? ""}</TableCell>
                          <TableCell>{row.mailingAddress2 ?? ""}</TableCell>
                          <TableCell>{row.cityStateZip ?? ""}</TableCell>
                          <TableCell>{formatNumber(row.recQuantity)}</TableCell>
                          <TableCell>{formatCurrency(row.recPrice)}</TableCell>
                          <TableCell>{formatNumber(row.acSizeKw)}</TableCell>
                          <TableCell>{formatNumber(row.dcSizeKw)}</TableCell>
                          <TableCell className="text-red-600">{row.error ?? ""}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
