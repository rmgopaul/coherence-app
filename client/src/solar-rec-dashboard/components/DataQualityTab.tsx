/**
 * Data Quality tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 7 of the
 * god-component decomposition. Owns:
 *   - 2 useMemos (dataQualityFreshness, dataQualityUnmatched)
 *   - dataset freshness badges + cross-reference reconciliation
 *
 * `dataHealthSummary` and `part2FilterAudit` STAY in the parent
 * because the sticky header strip at the top of the dashboard reads
 * them on every tab. Only the data-quality-tab-specific memos move.
 */

import { memo, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
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
  formatNumber,
  toPercentValue,
} from "@/solar-rec-dashboard/lib/helpers";
import type {
  CsvDataset,
  DatasetKey,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DataQualityTabProps {
  /** Full dataset bag — drives both the freshness table and the reconciliation. */
  datasets: Partial<Record<DatasetKey, CsvDataset>>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const DATASET_LABELS: Record<string, string> = {
  solarApplications: "Solar Applications",
  abpReport: "ABP Report",
  generationEntry: "Generation Entry",
  accountSolarGeneration: "Account Solar Generation",
  contractedDate: "Contracted Date",
  annualProductionEstimates: "Annual Production Estimates",
  generatorDetails: "Generator Details",
  convertedReads: "Converted Reads",
  deliveryScheduleBase: "Delivery Schedule (Schedule B)",
  transferHistory: "Transfer History (GATS)",
};

export default memo(function DataQualityTab(props: DataQualityTabProps) {
  const { datasets } = props;

  const dataQualityFreshness = useMemo(() => {
    const now = new Date();
    return Object.entries(DATASET_LABELS).map(([key, label]) => {
      const ds = datasets[key as keyof typeof datasets];
      const uploadedAt = ds?.uploadedAt ?? null;
      const ageDays = uploadedAt
        ? Math.floor((now.getTime() - uploadedAt.getTime()) / (1000 * 60 * 60 * 24))
        : null;
      const rowCount = ds?.rows?.length ?? 0;
      const status = !uploadedAt
        ? "Missing"
        : ageDays! <= 7
          ? "Fresh"
          : ageDays! <= 14
            ? "Stale"
            : "Critical";
      return {
        key,
        label,
        uploadedAt: uploadedAt?.toLocaleDateString() ?? "Not uploaded",
        ageDays,
        rowCount,
        status,
      };
    });
  }, [datasets]);

  const dataQualityUnmatched = useMemo(() => {
    const scheduleIds = new Set<string>();
    const monitoringIds = new Set<string>();

    // Phase 1a: the Delivery Tracker / Performance Eval obligations now come
    // from deliveryScheduleBase (Schedule B scrape), so we reconcile tracking
    // IDs against that dataset instead of the removed recDeliverySchedules.
    (datasets.deliveryScheduleBase?.rows ?? []).forEach((row) => {
      const id = row.tracking_system_ref_id || row.system_id || "";
      if (id) scheduleIds.add(id.toLowerCase());
    });

    (datasets.convertedReads?.rows ?? []).forEach((row) => {
      const id = row.monitoring_system_id || "";
      if (id) monitoringIds.add(id.toLowerCase());
    });

    const inScheduleNotMonitoring = Array.from(scheduleIds).filter(
      (id) => !monitoringIds.has(id),
    );
    const inMonitoringNotSchedule = Array.from(monitoringIds).filter(
      (id) => !scheduleIds.has(id),
    );
    const combined = new Set(
      Array.from(scheduleIds).concat(Array.from(monitoringIds)),
    );
    const totalUnique = combined.size;
    const matched =
      totalUnique - inScheduleNotMonitoring.length - inMonitoringNotSchedule.length;
    const matchedPercent = toPercentValue(matched, totalUnique);

    return { inScheduleNotMonitoring, inMonitoringNotSchedule, matchedPercent };
  }, [datasets.deliveryScheduleBase, datasets.convertedReads]);

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dataset Freshness</CardTitle>
          <CardDescription>
            Upload status and age for each required dataset.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dataset</TableHead>
                <TableHead>Last Updated</TableHead>
                <TableHead className="text-right">Age (days)</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dataQualityFreshness.map((d) => (
                <TableRow key={d.key}>
                  <TableCell className="font-medium">{d.label}</TableCell>
                  <TableCell>{d.uploadedAt}</TableCell>
                  <TableCell className="text-right">
                    {d.ageDays !== null ? d.ageDays : "—"}
                  </TableCell>
                  <TableCell className="text-right">{formatNumber(d.rowCount)}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        d.status === "Fresh"
                          ? "default"
                          : d.status === "Stale"
                            ? "secondary"
                            : d.status === "Critical"
                              ? "destructive"
                              : "outline"
                      }
                    >
                      {d.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">System Reconciliation</CardTitle>
          <CardDescription>
            Cross-reference between delivery schedules and monitoring data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-center">
              <p className="text-xs text-slate-500">Match Rate</p>
              <p className="text-lg font-semibold text-emerald-800">
                {dataQualityUnmatched.matchedPercent !== null
                  ? `${dataQualityUnmatched.matchedPercent.toFixed(1)}%`
                  : "N/A"}
              </p>
            </div>
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-center">
              <p className="text-xs text-slate-500">In Schedule, No Monitoring</p>
              <p className="text-lg font-semibold text-amber-800">
                {dataQualityUnmatched.inScheduleNotMonitoring.length}
              </p>
            </div>
            <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-center">
              <p className="text-xs text-slate-500">In Monitoring, No Schedule</p>
              <p className="text-lg font-semibold text-sky-800">
                {dataQualityUnmatched.inMonitoringNotSchedule.length}
              </p>
            </div>
          </div>
          {dataQualityUnmatched.inScheduleNotMonitoring.length > 0 && (
            <details className="mb-3">
              <summary className="text-sm font-medium cursor-pointer text-amber-700">
                Systems in schedule but missing monitoring (
                {dataQualityUnmatched.inScheduleNotMonitoring.length})
              </summary>
              <div className="mt-2 max-h-48 overflow-y-auto rounded border p-2 text-xs font-mono space-y-1">
                {dataQualityUnmatched.inScheduleNotMonitoring.map((id) => (
                  <div key={id}>{id}</div>
                ))}
              </div>
            </details>
          )}
          {dataQualityUnmatched.inMonitoringNotSchedule.length > 0 && (
            <details>
              <summary className="text-sm font-medium cursor-pointer text-sky-700">
                Systems in monitoring but not in schedule (
                {dataQualityUnmatched.inMonitoringNotSchedule.length})
              </summary>
              <div className="mt-2 max-h-48 overflow-y-auto rounded border p-2 text-xs font-mono space-y-1">
                {dataQualityUnmatched.inMonitoringNotSchedule.map((id) => (
                  <div key={id}>{id}</div>
                ))}
              </div>
            </details>
          )}
        </CardContent>
      </Card>
    </div>
  );
});
