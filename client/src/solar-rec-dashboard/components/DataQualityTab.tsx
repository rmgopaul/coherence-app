/**
 * Data Quality tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 7 of the
 * god-component decomposition. Owns:
 *   - 1 useMemo (dataQualityFreshness)
 *   - 1 tRPC query (`getDashboardDataQualityReconciliation`,
 *     introduced by Task 5.14 PR-4 to replace the prior
 *     `dataQualityUnmatched` useMemo that walked
 *     `datasets.deliveryScheduleBase.rows` +
 *     `datasets.convertedReads.rows` to compute the same set
 *     difference)
 *   - dataset freshness badges + cross-reference reconciliation
 *
 * `dataHealthSummary` and `part2FilterAudit` STAY in the parent
 * because the sticky header strip at the top of the dashboard reads
 * them on every tab. Only the data-quality-tab-specific memos move.
 */

import { memo, useMemo } from "react";
import { AskAiPanel } from "@/components/AskAiPanel";
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
import { formatNumber } from "@/solar-rec-dashboard/lib/helpers";
import type {
  CsvDataset,
  DatasetKey,
} from "@/solar-rec-dashboard/state/types";
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DataQualityTabProps {
  /**
   * Full dataset bag — drives the freshness table only. The
   * reconciliation moved server-side in Task 5.14 PR-4 and no
   * longer reads `datasets[k].rows`. Task 5.14 PR-5 will drop
   * this prop entirely once the parent's in-memory state goes
   * away.
   */
  datasets: Partial<Record<DatasetKey, CsvDataset>>;
  /**
   * PR-7 (data-flow series): server-side summaries from
   * `getDatasetSummariesAll`. When present for a given key, the
   * freshness table prefers the server-side `rowCount` and
   * `lastUpdated` instead of reading `ds.rows.length` / `ds.uploadedAt`
   * from the in-memory dataset. This means the Data Quality tab
   * shows accurate counts even before (or after) the row arrays
   * have been materialized into JS heap — which is the whole point
   * of the data-flow refactor.
   *
   * Optional so the tab degrades gracefully if the parent hasn't
   * wired the prop yet (PR-6 added the query; PR-7 wires it here).
   */
  datasetSummariesByKey?: Partial<
    Record<
      string,
      {
        rowCount: number | null;
        byteCount: number | null;
        cloudStatus: "synced" | "failed" | "missing";
        lastUpdated: string | null;
        isRowBacked: boolean;
      }
    >
  >;
  /**
   * Gates the reconciliation query so it only fires when the
   * Data Quality tab is the active tab. Mirrors the pattern
   * from the other Task 5.13 + 5.14 tab migrations (Trends,
   * AppPipeline, etc.).
   */
  isActive: boolean;
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
  const { datasets, datasetSummariesByKey, isActive } = props;

  // Task 5.14 PR-4: reconciliation moved server-side. The query
  // only fires when the user is on this tab; cached server-side via
  // `solarRecComputedArtifacts` keyed on the
  // (deliveryScheduleBase batch, convertedReads batch) input
  // version hash.
  const reconciliationQuery =
    solarRecTrpc.solarRecDashboard.getDashboardDataQualityReconciliation.useQuery(
      undefined,
      {
        enabled: isActive,
        staleTime: 60_000,
      }
    );
  const dataQualityUnmatched = useMemo(
    () => ({
      inScheduleNotMonitoring:
        reconciliationQuery.data?.inScheduleNotMonitoring ?? [],
      inMonitoringNotSchedule:
        reconciliationQuery.data?.inMonitoringNotSchedule ?? [],
      matchedPercent: reconciliationQuery.data?.matchedPercent ?? null,
    }),
    [reconciliationQuery.data]
  );

  const dataQualityFreshness = useMemo(() => {
    const now = new Date();
    return Object.entries(DATASET_LABELS).map(([key, label]) => {
      const ds = datasets[key as keyof typeof datasets];
      const summary = datasetSummariesByKey?.[key];

      // PR-7: prefer the server-side summary's lastUpdated +
      // rowCount when available. Falls back to the in-memory
      // dataset for the 11 non-row-backed datasets where the
      // server `rowCount` is null until PR-7's row-table
      // migration ships (deferred — see PR-8 series notes).
      const serverUpdatedAt = summary?.lastUpdated
        ? new Date(summary.lastUpdated)
        : null;
      const uploadedAt = serverUpdatedAt ?? ds?.uploadedAt ?? null;
      const ageDays = uploadedAt
        ? Math.floor((now.getTime() - uploadedAt.getTime()) / (1000 * 60 * 60 * 24))
        : null;
      const rowCount =
        typeof summary?.rowCount === "number" && summary.rowCount > 0
          ? summary.rowCount
          : (ds?.rows?.length ?? 0);
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
  }, [datasets, datasetSummariesByKey]);

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

      <AskAiPanel
        moduleKey="solar-rec-data-quality"
        title="Ask AI about data quality"
        contextGetter={() => ({
          freshness: dataQualityFreshness,
          reconciliation: {
            matchedPercent: dataQualityUnmatched.matchedPercent,
            inScheduleNotMonitoringCount:
              dataQualityUnmatched.inScheduleNotMonitoring.length,
            inMonitoringNotScheduleCount:
              dataQualityUnmatched.inMonitoringNotSchedule.length,
            sampleInScheduleNotMonitoring:
              dataQualityUnmatched.inScheduleNotMonitoring.slice(0, 30),
            sampleInMonitoringNotSchedule:
              dataQualityUnmatched.inMonitoringNotSchedule.slice(0, 30),
          },
        })}
      />
    </div>
  );
});
