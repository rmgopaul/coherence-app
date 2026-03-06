import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  type DeepUpdateReportData,
  type DeepUpdateReportKey,
  parseDeepUpdateReportFile,
  synthesizeDeepUpdate,
  type DeepUpdateSynthesisResult,
} from "@/lib/deepUpdateSynth";
import { ArrowLeft, Download, Loader2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const REPORTS: Array<{ key: DeepUpdateReportKey; label: string; required: boolean; description: string }> = [
  {
    key: "portal",
    label: "Portal",
    required: true,
    description: "Main portal export containing system_id, internal_status, sd_status, and contract_status.",
  },
  {
    key: "abpReport",
    label: "ABP Report",
    required: true,
    description: "ABP export containing Part_1/Part_2 statuses, batch, trade date, and contract IDs.",
  },
  {
    key: "sd",
    label: "SD",
    required: true,
    description: "SD export used for fallback status by FormID.",
  },
  {
    key: "iccReport1",
    label: "ICC Report 1",
    required: false,
    description: "Uploadable for completeness. Current synthesis logic does not require it yet.",
  },
  {
    key: "iccReport2",
    label: "ICC Report 2",
    required: true,
    description: "Used for REC price fallback, contract value fallback, and scheduled energization date.",
  },
  {
    key: "iccReport3",
    label: "ICC Report 3",
    required: true,
    description: "Primary source for REC price and total REC delivery contract value.",
  },
  {
    key: "portalPayments",
    label: "Portal Payments (Optional)",
    required: false,
    description: "Recommended if you want payment-based steps (Step 4.2 / 4.3) resolved.",
  },
];

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error.";
}

function triggerCsvDownload(fileName: string, csvText: string): void {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function DeepUpdateSynthesizer() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();

  const [reports, setReports] = useState<Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>>>({});
  const [uploadErrors, setUploadErrors] = useState<Partial<Record<DeepUpdateReportKey, string>>>({});
  const [activeUpload, setActiveUpload] = useState<DeepUpdateReportKey | null>(null);
  const [result, setResult] = useState<DeepUpdateSynthesisResult | null>(null);
  const [synthError, setSynthError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  const missingRequired = useMemo(
    () => REPORTS.filter((report) => report.required && !reports[report.key]),
    [reports]
  );

  const previewRows = useMemo(() => (result ? result.rows.slice(0, 200) : []), [result]);
  const deepUpdatePreviewRows = useMemo(() => (result ? result.rows.slice(0, 30).map((row) => row.deepUpdateRow) : []), [result]);

  const handleUpload = async (key: DeepUpdateReportKey, file: File | null) => {
    if (!file) return;
    setActiveUpload(key);
    setUploadErrors((previous) => ({ ...previous, [key]: undefined }));
    try {
      const parsed = await parseDeepUpdateReportFile(file, key);
      setReports((previous) => ({ ...previous, [key]: parsed }));
      setResult(null);
      setSynthError(null);
      toast.success(`${REPORTS.find((item) => item.key === key)?.label ?? key} uploaded (${parsed.rows.length} rows).`);
    } catch (error) {
      const message = toErrorMessage(error);
      setUploadErrors((previous) => ({ ...previous, [key]: message }));
      toast.error(message);
    } finally {
      setActiveUpload(null);
    }
  };

  const clearUpload = (key: DeepUpdateReportKey) => {
    setReports((previous) => ({ ...previous, [key]: undefined }));
    setUploadErrors((previous) => ({ ...previous, [key]: undefined }));
    setResult(null);
    setSynthError(null);
  };

  const runSynthesis = () => {
    setIsRunning(true);
    setSynthError(null);
    try {
      const synthesized = synthesizeDeepUpdate(reports);
      setResult(synthesized);
      toast.success(`Synthesized ${synthesized.summary.synthesizedRows} row(s).`);
    } catch (error) {
      const message = toErrorMessage(error);
      setSynthError(message);
      toast.error(message);
    } finally {
      setIsRunning(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
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
          <h1 className="text-2xl font-bold text-slate-900">Deep Update Synthesizer</h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload report files, compute Calc Step Value/Internal Status deltas, and export Deep Update CSV.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Upload Reports</CardTitle>
            <CardDescription>
              Supported file types: CSV, XLSX, XLSM. You can upload one file per report type.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {REPORTS.map((report) => {
              const uploaded = reports[report.key];
              const isBusy = activeUpload === report.key;
              const uploadError = uploadErrors[report.key];
              return (
                <div key={report.key} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-slate-900">{report.label}</p>
                        {report.required ? (
                          <Badge className="bg-emerald-600 text-white">Required</Badge>
                        ) : (
                          <Badge variant="secondary">Optional</Badge>
                        )}
                      </div>
                      <p className="text-sm text-slate-600">{report.description}</p>
                      {uploaded ? (
                        <p className="text-xs text-slate-500">
                          Loaded: {uploaded.fileName} ({uploaded.rows.length.toLocaleString()} rows, sheet: {uploaded.sheetName})
                        </p>
                      ) : (
                        <p className="text-xs text-slate-500">No file uploaded yet.</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`upload-${report.key}`} className="sr-only">
                        Upload {report.label}
                      </Label>
                      <Input
                        id={`upload-${report.key}`}
                        type="file"
                        accept=".csv,.xlsx,.xlsm,.xls"
                        disabled={isBusy}
                        onChange={(event) => {
                          const file = event.target.files?.[0] ?? null;
                          void handleUpload(report.key, file);
                          event.currentTarget.value = "";
                        }}
                        className="max-w-[300px]"
                      />
                      <Button type="button" variant="outline" onClick={() => clearUpload(report.key)} disabled={!uploaded || isBusy}>
                        Clear
                      </Button>
                    </div>
                  </div>
                  {isBusy && (
                    <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Parsing file...
                    </div>
                  )}
                  {uploadError && <p className="mt-2 text-sm text-red-600">{uploadError}</p>}
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) Synthesize + Export</CardTitle>
            <CardDescription>
              Run the workbook-style logic and produce two outputs: Deep Update CSV and internal-status comparison CSV.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {missingRequired.length > 0 ? (
              <p className="text-sm text-amber-700">
                Missing required uploads: {missingRequired.map((entry) => entry.label).join(", ")}.
              </p>
            ) : (
              <p className="text-sm text-emerald-700">All required reports are loaded.</p>
            )}
            {synthError && <p className="text-sm text-red-600">{synthError}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runSynthesis} disabled={missingRequired.length > 0 || isRunning}>
                {isRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
                Run Synthesis
              </Button>
              <Button
                variant="outline"
                disabled={!result}
                onClick={() => result && triggerCsvDownload("deep-update-output.csv", result.deepUpdateCsvText)}
              >
                <Download className="h-4 w-4 mr-2" />
                Download Deep Update CSV
              </Button>
              <Button
                variant="outline"
                disabled={!result}
                onClick={() => result && triggerCsvDownload("internal-status-review.csv", result.statusCsvText)}
              >
                <Download className="h-4 w-4 mr-2" />
                Download Status Review CSV
              </Button>
            </div>
          </CardContent>
        </Card>

        {result && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Summary</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-5 gap-3">
                <div className="rounded-md border border-slate-200 p-3 bg-white">
                  <p className="text-xs text-slate-500 uppercase tracking-wide">Portal Rows</p>
                  <p className="text-xl font-semibold text-slate-900">{result.summary.totalPortalRows.toLocaleString()}</p>
                </div>
                <div className="rounded-md border border-slate-200 p-3 bg-white">
                  <p className="text-xs text-slate-500 uppercase tracking-wide">Synthesized</p>
                  <p className="text-xl font-semibold text-slate-900">{result.summary.synthesizedRows.toLocaleString()}</p>
                </div>
                <div className="rounded-md border border-amber-200 p-3 bg-amber-50">
                  <p className="text-xs text-amber-700 uppercase tracking-wide">Need Update</p>
                  <p className="text-xl font-semibold text-amber-800">{result.summary.rowsNeedingUpdate.toLocaleString()}</p>
                </div>
                <div className="rounded-md border border-red-200 p-3 bg-red-50">
                  <p className="text-xs text-red-700 uppercase tracking-wide">Missing ABP</p>
                  <p className="text-xl font-semibold text-red-800">{result.summary.rowsMissingAbpMatch.toLocaleString()}</p>
                </div>
                <div className="rounded-md border border-red-200 p-3 bg-red-50">
                  <p className="text-xs text-red-700 uppercase tracking-wide">Missing ICC</p>
                  <p className="text-xl font-semibold text-red-800">{result.summary.rowsMissingIccMatch.toLocaleString()}</p>
                </div>
              </CardContent>
            </Card>

            {result.warnings.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Warnings</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1">
                  {result.warnings.map((warning) => (
                    <p key={warning} className="text-sm text-amber-700">
                      - {warning}
                    </p>
                  ))}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Status Preview (First 200 Rows)</CardTitle>
                <CardDescription>
                  Use this to review where computed calc-step status differs from current internal status.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-[540px] overflow-auto rounded-md border border-slate-200">
                  <Table>
                    <TableHeader className="sticky top-0 bg-white z-10">
                      <TableRow>
                        <TableHead>Portal ID</TableHead>
                        <TableHead>System Name</TableHead>
                        <TableHead>Internal Status</TableHead>
                        <TableHead>Internal Value</TableHead>
                        <TableHead>Calculated Step</TableHead>
                        <TableHead>Calc Value</TableHead>
                        <TableHead>Should Update?</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewRows.map((row, index) => (
                        <TableRow key={`status-${row.id}-${index}`}>
                          <TableCell className="font-mono text-xs">{row.id}</TableCell>
                          <TableCell className="max-w-[260px] truncate">{row.systemName || "—"}</TableCell>
                          <TableCell className="max-w-[300px] truncate">{row.internalStatus || "—"}</TableCell>
                          <TableCell>{row.internalStatusValue ?? "—"}</TableCell>
                          <TableCell className="max-w-[320px] truncate">{row.calculatedStep}</TableCell>
                          <TableCell>{row.calcStepValue ?? "—"}</TableCell>
                          <TableCell>
                            {row.shouldBeUpdated ? (
                              <Badge className="bg-amber-500 text-amber-950">Yes</Badge>
                            ) : (
                              <Badge variant="secondary">No</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Deep Update Preview (First 30 Rows)</CardTitle>
                <CardDescription>
                  This mirrors the Deep Update output format: id + 10 update columns.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-[420px] overflow-auto rounded-md border border-slate-200">
                  <Table>
                    <TableHeader className="sticky top-0 bg-white z-10">
                      <TableRow>
                        <TableHead>id</TableHead>
                        <TableHead>est_payment_date</TableHead>
                        <TableHead>state_approval_date2</TableHead>
                        <TableHead>state_approval_date</TableHead>
                        <TableHead>standing_order_utility</TableHead>
                        <TableHead>rec_price</TableHead>
                        <TableHead>part1_submitted_date</TableHead>
                        <TableHead>part2_submitted_date</TableHead>
                        <TableHead>total_contract_amount</TableHead>
                        <TableHead>state_registration_approval_deadline</TableHead>
                        <TableHead>utility_contract_number</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {deepUpdatePreviewRows.map((row, index) => (
                        <TableRow key={`deep-${row.id}-${index}`}>
                          <TableCell className="font-mono text-xs">{row.id}</TableCell>
                          <TableCell>{row.est_payment_date}</TableCell>
                          <TableCell>{row.state_approval_date2}</TableCell>
                          <TableCell>{row.state_approval_date}</TableCell>
                          <TableCell>{row.standing_order_utility}</TableCell>
                          <TableCell>{row.rec_price}</TableCell>
                          <TableCell>{row.part1_submitted_date}</TableCell>
                          <TableCell>{row.part2_submitted_date}</TableCell>
                          <TableCell>{row.total_contract_amount}</TableCell>
                          <TableCell>{row.state_registration_approval_deadline}</TableCell>
                          <TableCell>{row.utility_contract_number}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
