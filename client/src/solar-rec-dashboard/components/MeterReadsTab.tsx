/**
 * Meter Reads tab.
 *
 * Extracted from SolarRecDashboard.tsx. Phase 8. Owns:
 *   - 3 useStates (meterReadsResult, meterReadsError, meterReadsBusy)
 *   - 2 callbacks (handleMeterReadsUpload, downloadMeterReadsCsv)
 *   - ~100 lines of JSX
 *
 * Self-contained: no shared parent data. The meter-reads workbook
 * converter is a one-shot Excel → CSV tool that doesn't interact with
 * any of the dashboard's derived memos or persistence layer.
 */

import { memo, useCallback, useState } from "react";
import { Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildMeterReadDownloadFileName,
  convertMeterReadWorkbook,
  type MeterReadsConversionResult,
} from "@/lib/meterReads";
import { formatNumber } from "@/solar-rec-dashboard/lib/helpers";
import { AskAiPanel } from "@/components/AskAiPanel";

export default memo(function MeterReadsTab() {
  const [meterReadsResult, setMeterReadsResult] =
    useState<MeterReadsConversionResult | null>(null);
  const [meterReadsError, setMeterReadsError] = useState<string | null>(null);
  const [meterReadsBusy, setMeterReadsBusy] = useState(false);

  const handleMeterReadsUpload = useCallback(async (file: File | null) => {
    if (!file) return;

    setMeterReadsBusy(true);
    setMeterReadsError(null);

    try {
      const result = await convertMeterReadWorkbook(file);
      setMeterReadsResult(result);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown error while converting meter read workbook.";
      setMeterReadsError(message);
    } finally {
      setMeterReadsBusy(false);
    }
  }, []);

  const downloadMeterReadsCsv = useCallback(() => {
    if (!meterReadsResult) return;

    const blob = new Blob([meterReadsResult.csvText], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = buildMeterReadDownloadFileName(meterReadsResult.readDate);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [meterReadsResult]);

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Meter Read Workbook Converter</CardTitle>
          <CardDescription>
            Upload the monthly meter read Excel workbook and generate the full
            portal-ready CSV output in one step.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Upload className="h-4 w-4" />
              Choose Excel Workbook
              <input
                type="file"
                accept=".xlsx,.xlsm,.xlsb,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  void handleMeterReadsUpload(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>

            <Button
              variant="outline"
              onClick={downloadMeterReadsCsv}
              disabled={!meterReadsResult || meterReadsBusy}
            >
              Download Converted CSV
            </Button>

            {meterReadsBusy ? (
              <Badge className="bg-blue-100 text-blue-800 border-blue-200">
                Processing workbook...
              </Badge>
            ) : null}
          </div>

          {meterReadsError ? (
            <p className="text-sm text-rose-700">{meterReadsError}</p>
          ) : null}

          {meterReadsResult ? (
            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-xs text-slate-500">Source Workbook</p>
                <p className="text-sm font-medium text-slate-900 break-all">
                  {meterReadsResult.sourceWorkbookName}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-xs text-slate-500">Read Date</p>
                <p className="text-sm font-medium text-slate-900">
                  {meterReadsResult.readDate}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-xs text-slate-500">Output Rows</p>
                <p className="text-sm font-medium text-slate-900">
                  {formatNumber(meterReadsResult.totalRows)}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-xs text-slate-500">Monitoring Platforms</p>
                <p className="text-sm font-medium text-slate-900">
                  {formatNumber(meterReadsResult.byMonitoring.length)}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-600">
              No workbook converted yet. Choose an Excel file to generate the output CSV.
            </p>
          )}

          {meterReadsResult && meterReadsResult.notes.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3">
              <p className="text-xs font-medium text-amber-900 mb-2">Conversion Notes</p>
              <ul className="list-disc pl-5 space-y-1 text-xs text-amber-800">
                {meterReadsResult.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {meterReadsResult ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Rows by Monitoring Platform</CardTitle>
            <CardDescription>
              Confirms how many rows were generated per platform before you
              download/upload.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Monitoring</TableHead>
                  <TableHead>Rows</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {meterReadsResult.byMonitoring.map((item) => (
                  <TableRow key={item.monitoring}>
                    <TableCell className="font-medium">{item.monitoring}</TableCell>
                    <TableCell>{formatNumber(item.rows)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <AskAiPanel
        moduleKey="solar-rec-meter-reads"
        title="Ask AI about meter reads"
        contextGetter={() =>
          meterReadsResult
            ? {
                sourceWorkbookName: meterReadsResult.sourceWorkbookName,
                readDate: meterReadsResult.readDate,
                totalRows: meterReadsResult.totalRows,
                byMonitoring: meterReadsResult.byMonitoring,
                notes: meterReadsResult.notes,
              }
            : { status: "no workbook converted yet" }
        }
      />
    </div>
  );
});
