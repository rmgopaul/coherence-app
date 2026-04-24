/**
 * Snapshot Log tab.
 *
 * Extracted from `SolarRecDashboard.tsx` in Phase 9c. Last of the
 * three REC performance spine tabs. Pure reader over `logEntries`
 * (the shared snapshot history) plus the `createLogEntry` /
 * `clearLogs` / `deleteLogEntry` callbacks from the parent.
 *
 * State that moves here (out of the parent):
 *   - `snapshotContractPage` + pagination clamp effect
 *   - `monthlySnapshotTransitions` (was a useState+useEffect; rewritten
 *     as a single useMemo because the effect was just a deferred compute,
 *     not an actual side effect)
 *
 * Memos that move here:
 *   - `snapshotTrendRows`, `snapshotTrendSummary`
 *   - `snapshotLogColumns`, `snapshotContractIds`,
 *     `snapshotContractMetricsByLogId`, `visibleSnapshotContractIds`
 *   - `snapshotMetricRows` (static definition, zero deps)
 *   - `cooNotTransferredNotReportingCurrentCount` — derived from
 *     `changeOwnershipRows` which is shared with Overview/ChangeOwnership,
 *     flows in as the precomputed number (cheap prop, keeps this
 *     component unaware of the ChangeOwnershipSummary shape)
 *
 * Helpers that move here (local to this file):
 *   - `formatTransitionBreakdown`
 *   - `TransitionStatus` type
 *   - `SnapshotMetricRow` type
 *
 * Parent still owns: `recPerformanceSnapshotContracts2025` (used by
 * `createLogEntry` to bake into each entry), `logEntries`,
 * `createLogEntry`, `clearLogs`, `deleteLogEntry`, and the log
 * persistence machinery. All flow down as props.
 */

import { memo, useEffect, useMemo, useState } from "react";
import { AskAiPanel } from "@/components/AskAiPanel";
import { Trash2 } from "lucide-react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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
import { formatCurrency, formatPercent } from "@/lib/helpers";
import {
  CHANGE_OWNERSHIP_ORDER,
  COO_TARGET_STATUS,
  NO_COO_STATUS,
  NUMBER_FORMATTER,
  SNAPSHOT_CONTRACT_PAGE_SIZE,
  SNAPSHOT_REC_PERFORMANCE_DELIVERY_YEAR_LABEL,
} from "@/solar-rec-dashboard/lib/constants";
import {
  formatNumber,
  toPercentValue,
} from "@/solar-rec-dashboard/lib/helpers";
import type {
  ChangeOwnershipStatus,
  DashboardLogEntry,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Local types + helpers
// ---------------------------------------------------------------------------

type TransitionStatus = ChangeOwnershipStatus | "No COO Status";

type SnapshotMetricRow =
  | {
      kind: "section";
      label: string;
      sectionTone: "slate" | "blue" | "emerald";
    }
  | {
      kind: "metric";
      label: string;
      value: (entry: DashboardLogEntry) => string;
      level?: 0 | 1;
      metricTone?: "default" | "neutral" | "warn";
    };

function formatTransitionBreakdown(
  breakdown: Map<TransitionStatus, number>,
): string {
  const orderedStatuses: TransitionStatus[] = [
    ...CHANGE_OWNERSHIP_ORDER,
    NO_COO_STATUS,
  ];
  const parts = orderedStatuses
    .map((status) => ({ status, count: breakdown.get(status) ?? 0 }))
    .filter((item) => item.count > 0)
    .map((item) => `${item.status}: ${NUMBER_FORMATTER.format(item.count)}`);
  return parts.length > 0 ? parts.join(" | ") : "None";
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Minimal shape of each row inside `recPerformanceSnapshotContracts2025`.
 * We avoid importing the full type from the parent's memo — only the
 * `contractId` is consumed by the fallback branch in
 * `snapshotContractIds`.
 */
export type SnapshotRecPerformanceContractRow = {
  contractId: string;
};

export interface SnapshotLogTabProps {
  logEntries: DashboardLogEntry[];
  /**
   * Live per-contract shortfall rows for the current delivery year.
   * Used only as a fallback for `snapshotContractIds` when no logged
   * snapshot contains REC performance data yet.
   */
  recPerformanceSnapshotContracts2025: SnapshotRecPerformanceContractRow[];
  /**
   * Current count of systems in the "Change of Ownership — Not
   * Transferred and Not Reporting" status (the COO target). Computed
   * in the parent because the Overview and Change of Ownership tabs
   * also consume the source `changeOwnershipRows`.
   */
  cooNotTransferredNotReportingCurrentCount: number;
  onCreateLogEntry: () => void;
  onClearLogs: () => void;
  onDeleteLogEntry: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function SnapshotLogTab(props: SnapshotLogTabProps) {
  const {
    logEntries,
    recPerformanceSnapshotContracts2025,
    cooNotTransferredNotReportingCurrentCount,
    onCreateLogEntry,
    onClearLogs,
    onDeleteLogEntry,
  } = props;

  const [snapshotContractPage, setSnapshotContractPage] = useState(1);

  // ── Monthly COO transitions ─────────────────────────────────────
  //
  // Rewritten as a useMemo (was a useState+useEffect in the parent
  // whose sole purpose was to defer the compute by one microtask tick
  // — not an actual side effect).
  const monthlySnapshotTransitions = useMemo(() => {
    const monthLatest = new Map<string, DashboardLogEntry>();

    logEntries.forEach((entry) => {
      const key = `${entry.createdAt.getFullYear()}-${String(entry.createdAt.getMonth() + 1).padStart(2, "0")}`;
      const existing = monthLatest.get(key);
      if (!existing || entry.createdAt > existing.createdAt) {
        monthLatest.set(key, entry);
      }
    });

    const monthlySeries = Array.from(monthLatest.entries())
      .map(([key, entry]) => ({ monthKey: key, entry }))
      .sort((a, b) => a.entry.createdAt.getTime() - b.entry.createdAt.getTime());

    const transitions: Array<{
      monthKey: string;
      monthLabel: string;
      movedIn: number;
      movedOut: number;
      net: number;
      endingCount: number;
      movedInBreakdown: string;
      movedOutBreakdown: string;
    }> = [];

    for (let i = 1; i < monthlySeries.length; i += 1) {
      const previous = monthlySeries[i - 1]!;
      const current = monthlySeries[i]!;

      const previousMap = new Map<string, TransitionStatus>();
      const currentMap = new Map<string, TransitionStatus>();
      const previousTargetKeys = new Set<string>();
      const currentTargetKeys = new Set<string>();

      previous.entry.cooStatuses.forEach((item) => {
        previousMap.set(item.key, item.status);
        if (item.status === COO_TARGET_STATUS) previousTargetKeys.add(item.key);
      });
      current.entry.cooStatuses.forEach((item) => {
        currentMap.set(item.key, item.status);
        if (item.status === COO_TARGET_STATUS) currentTargetKeys.add(item.key);
      });

      const allKeys = new Set<string>([
        ...Array.from(previousTargetKeys),
        ...Array.from(currentTargetKeys),
      ]);
      const movedInBreakdown = new Map<TransitionStatus, number>();
      const movedOutBreakdown = new Map<TransitionStatus, number>();
      let movedIn = 0;
      let movedOut = 0;
      let endingCount = 0;

      allKeys.forEach((key) => {
        const prevStatus = previousMap.get(key) ?? NO_COO_STATUS;
        const currStatus = currentMap.get(key) ?? NO_COO_STATUS;

        if (currStatus === COO_TARGET_STATUS) endingCount += 1;
        if (prevStatus !== COO_TARGET_STATUS && currStatus === COO_TARGET_STATUS) {
          movedIn += 1;
          movedInBreakdown.set(
            prevStatus,
            (movedInBreakdown.get(prevStatus) ?? 0) + 1,
          );
        }
        if (prevStatus === COO_TARGET_STATUS && currStatus !== COO_TARGET_STATUS) {
          movedOut += 1;
          movedOutBreakdown.set(
            currStatus,
            (movedOutBreakdown.get(currStatus) ?? 0) + 1,
          );
        }
      });

      transitions.push({
        monthKey: current.monthKey,
        monthLabel: current.entry.createdAt.toLocaleDateString("en-US", {
          month: "short",
          year: "numeric",
        }),
        movedIn,
        movedOut,
        net: movedIn - movedOut,
        endingCount,
        movedInBreakdown: formatTransitionBreakdown(movedInBreakdown),
        movedOutBreakdown: formatTransitionBreakdown(movedOutBreakdown),
      });
    }

    return transitions.reverse();
  }, [logEntries]);

  // ── Snapshot columns + contract IDs ─────────────────────────────
  const snapshotLogColumns = useMemo(() => logEntries.slice(0, 12), [logEntries]);

  const snapshotContractIds = useMemo(() => {
    const ids = new Set<string>();
    snapshotLogColumns.forEach((entry) => {
      (entry.recPerformanceContracts2025 ?? []).forEach((item) => {
        ids.add(item.contractId);
      });
    });
    if (ids.size === 0) {
      recPerformanceSnapshotContracts2025.forEach((item) => ids.add(item.contractId));
    }
    return Array.from(ids).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    );
  }, [recPerformanceSnapshotContracts2025, snapshotLogColumns]);

  const snapshotContractMetricsByLogId = useMemo(() => {
    const mapping = new Map<
      string,
      Map<
        string,
        {
          contractId: string;
          deliveryYearLabel: string;
          requiredToAvoidShortfallRecs: number;
          deliveredTowardShortfallRecs: number;
          deliveredPercentOfRequired: number | null;
          unallocatedShortfallRecs: number;
        }
      >
    >();
    snapshotLogColumns.forEach((entry) => {
      const byContract = new Map<
        string,
        {
          contractId: string;
          deliveryYearLabel: string;
          requiredToAvoidShortfallRecs: number;
          deliveredTowardShortfallRecs: number;
          deliveredPercentOfRequired: number | null;
          unallocatedShortfallRecs: number;
        }
      >();
      (entry.recPerformanceContracts2025 ?? []).forEach((item) => {
        byContract.set(item.contractId, item);
      });
      mapping.set(entry.id, byContract);
    });
    return mapping;
  }, [snapshotLogColumns]);

  const snapshotContractTotalPages = Math.max(
    1,
    Math.ceil(snapshotContractIds.length / SNAPSHOT_CONTRACT_PAGE_SIZE),
  );
  const snapshotContractCurrentPage = Math.min(
    snapshotContractPage,
    snapshotContractTotalPages,
  );
  const snapshotContractStartIndex =
    (snapshotContractCurrentPage - 1) * SNAPSHOT_CONTRACT_PAGE_SIZE;
  const snapshotContractEndIndex =
    snapshotContractStartIndex + SNAPSHOT_CONTRACT_PAGE_SIZE;
  const visibleSnapshotContractIds = useMemo(
    () =>
      snapshotContractIds.slice(snapshotContractStartIndex, snapshotContractEndIndex),
    [snapshotContractEndIndex, snapshotContractIds, snapshotContractStartIndex],
  );

  useEffect(() => {
    if (snapshotContractPage <= snapshotContractTotalPages) return;
    setSnapshotContractPage(snapshotContractTotalPages);
  }, [snapshotContractPage, snapshotContractTotalPages]);

  // ── Trend chart data ────────────────────────────────────────────
  const snapshotTrendRows = useMemo(() => {
    const sorted = [...logEntries].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    return sorted.map((entry, idx) => {
      const reportingPct =
        entry.reportingPercent ??
        toPercentValue(entry.reportingSystems, entry.totalSystems);
      const contractValuePct =
        entry.contractedValueReportingPercent ??
        toPercentValue(
          entry.contractedValueReporting ?? 0,
          entry.totalContractedValue,
        );
      const prev = idx > 0 ? sorted[idx - 1]! : null;
      const prevReportingPct = prev
        ? (prev.reportingPercent ??
            toPercentValue(prev.reportingSystems, prev.totalSystems))
        : null;
      const reportingDelta =
        prevReportingPct !== null && reportingPct !== null
          ? +(reportingPct - prevReportingPct).toFixed(2)
          : null;

      return {
        id: entry.id,
        label: entry.createdAt.toLocaleDateString([], {
          month: "numeric",
          day: "numeric",
        }),
        timestamp: entry.createdAt.toLocaleString(),
        reportingPercent: reportingPct,
        reportingDelta,
        contractValueReportingPercent: contractValuePct,
        cooNotTransferredNotReporting: entry.changedNotTransferredNotReporting,
        cooNotTransferredNotReportingPercent: toPercentValue(
          entry.changedNotTransferredNotReporting,
          entry.totalSystems,
        ),
        changeOwnershipPercent:
          entry.changeOwnershipPercent ??
          toPercentValue(entry.changeOwnershipSystems, entry.totalSystems),
        totalSystems: entry.totalSystems,
        reportingSystems: entry.reportingSystems,
        contractedValueNotReporting: entry.contractedValueNotReporting,
        totalGap: entry.totalGap,
      };
    });
  }, [logEntries]);

  const snapshotTrendSummary = useMemo(() => {
    if (snapshotTrendRows.length === 0) return null;
    const latest = snapshotTrendRows[snapshotTrendRows.length - 1]!;
    const prior =
      snapshotTrendRows.length > 1
        ? snapshotTrendRows[snapshotTrendRows.length - 2]!
        : null;

    const pctValues = snapshotTrendRows
      .flatMap((r) => [r.reportingPercent, r.contractValueReportingPercent])
      .filter((v): v is number => v !== null && v !== undefined);
    const minPct = pctValues.length > 0 ? Math.min(...pctValues) : 0;
    const maxPct = pctValues.length > 0 ? Math.max(...pctValues) : 100;
    const pctPadding = Math.max((maxPct - minPct) * 0.2, 3);
    const pctDomain: [number, number] = [
      Math.max(0, Math.floor(minPct - pctPadding)),
      Math.min(100, Math.ceil(maxPct + pctPadding)),
    ];

    const cvDelta =
      prior &&
      latest.contractValueReportingPercent !== null &&
      prior.contractValueReportingPercent !== null
        ? +(
            latest.contractValueReportingPercent -
            prior.contractValueReportingPercent
          ).toFixed(2)
        : null;

    return {
      latestReportingPct: latest.reportingPercent,
      reportingDelta: latest.reportingDelta,
      latestContractValuePct: latest.contractValueReportingPercent,
      contractValueDelta: cvDelta,
      latestCooNtNr: latest.cooNotTransferredNotReporting,
      pctDomain,
    };
  }, [snapshotTrendRows]);

  // ── Static metric rows for the vertical log table ───────────────
  const snapshotMetricRows = useMemo<SnapshotMetricRow[]>(
    () => [
      { kind: "section", label: "Portfolio Coverage", sectionTone: "slate" },
      {
        kind: "metric",
        label: "Part II Verified ABP Customers",
        value: (entry: DashboardLogEntry) => formatNumber(entry.totalSystems),
      },
      {
        kind: "metric",
        label: "Quantity Reporting to GATS",
        value: (entry: DashboardLogEntry) => formatNumber(entry.reportingSystems),
      },
      {
        kind: "metric",
        label: "Percentage Reporting to GATS",
        value: (entry: DashboardLogEntry) => formatPercent(entry.reportingPercent),
        metricTone: "neutral",
      },

      { kind: "section", label: "Change of Ownership", sectionTone: "blue" },
      {
        kind: "metric",
        label: "Quantity Change of Ownership",
        value: (entry: DashboardLogEntry) =>
          formatNumber(entry.changeOwnershipSystems),
      },
      {
        kind: "metric",
        label: "Percentage Change of Ownership",
        value: (entry: DashboardLogEntry) =>
          formatPercent(entry.changeOwnershipPercent),
        metricTone: "neutral",
      },
      {
        kind: "metric",
        label: "IL ABP - Transferred",
        value: (entry: DashboardLogEntry) =>
          formatNumber(entry.transferredReporting + entry.transferredNotReporting),
      },
      {
        kind: "metric",
        label: "Transferred and Reporting",
        level: 1,
        value: (entry: DashboardLogEntry) => formatNumber(entry.transferredReporting),
      },
      {
        kind: "metric",
        label: "Transferred and Not Reporting",
        level: 1,
        value: (entry: DashboardLogEntry) =>
          formatNumber(entry.transferredNotReporting),
      },
      {
        kind: "metric",
        label: "IL ABP - Terminated",
        value: (entry: DashboardLogEntry) =>
          formatNumber(entry.terminatedReporting + entry.terminatedNotReporting),
      },
      {
        kind: "metric",
        label: "COO - Not Transferred and Reporting",
        value: (entry: DashboardLogEntry) =>
          formatNumber(entry.changedNotTransferredReporting),
      },
      {
        kind: "metric",
        label: "COO - Not Transferred and Not Reporting",
        value: (entry: DashboardLogEntry) =>
          formatNumber(entry.changedNotTransferredNotReporting),
        metricTone: "warn",
      },

      { kind: "section", label: "Contract Value", sectionTone: "emerald" },
      {
        kind: "metric",
        label: "Total Contract Value",
        value: (entry: DashboardLogEntry) =>
          formatCurrency(entry.totalContractedValue),
      },
      {
        kind: "metric",
        label: "Total Contract Value Reporting",
        level: 1,
        value: (entry: DashboardLogEntry) =>
          formatCurrency(entry.contractedValueReporting),
      },
      {
        kind: "metric",
        label: "Total Contract Value Not Reporting",
        level: 1,
        value: (entry: DashboardLogEntry) =>
          formatCurrency(entry.contractedValueNotReporting),
      },
      {
        kind: "metric",
        label: "Percent Contract Value Reporting",
        level: 1,
        value: (entry: DashboardLogEntry) =>
          formatPercent(entry.contractedValueReportingPercent),
        metricTone: "neutral",
      },
      {
        kind: "metric",
        label: "Total Delivered Value",
        value: (entry: DashboardLogEntry) =>
          formatCurrency(entry.totalDeliveredValue),
      },
      {
        kind: "metric",
        label: "Total Value Gap",
        value: (entry: DashboardLogEntry) => formatCurrency(entry.totalGap),
        metricTone: "warn",
      },
    ],
    [],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-4 mt-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>{COO_TARGET_STATUS}</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(cooNotTransferredNotReportingCurrentCount)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Months with Transition Data</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(monthlySnapshotTransitions.length)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Snapshots Available</CardDescription>
            <CardTitle className="text-2xl">{formatNumber(logEntries.length)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Snapshot Trend</CardTitle>
          <CardDescription>
            Portfolio health over time — auto-updated with each snapshot.
          </CardDescription>
          {snapshotTrendSummary && (
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 pt-2">
              <div className="flex items-center gap-1.5 text-sm">
                <span className="text-slate-500">Reporting</span>
                <span className="font-semibold text-teal-700">
                  {snapshotTrendSummary.latestReportingPct !== null
                    ? `${snapshotTrendSummary.latestReportingPct.toFixed(1)}%`
                    : "—"}
                </span>
                {snapshotTrendSummary.reportingDelta !== null && (
                  <Badge
                    variant="outline"
                    className={
                      snapshotTrendSummary.reportingDelta >= 0
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700 text-xs"
                        : "border-red-200 bg-red-50 text-red-700 text-xs"
                    }
                  >
                    {snapshotTrendSummary.reportingDelta >= 0 ? "▲" : "▼"}{" "}
                    {Math.abs(snapshotTrendSummary.reportingDelta).toFixed(1)}pp
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-sm">
                <span className="text-slate-500">Contract Value</span>
                <span className="font-semibold text-blue-700">
                  {snapshotTrendSummary.latestContractValuePct !== null
                    ? `${snapshotTrendSummary.latestContractValuePct.toFixed(1)}%`
                    : "—"}
                </span>
                {snapshotTrendSummary.contractValueDelta !== null && (
                  <Badge
                    variant="outline"
                    className={
                      snapshotTrendSummary.contractValueDelta >= 0
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700 text-xs"
                        : "border-red-200 bg-red-50 text-red-700 text-xs"
                    }
                  >
                    {snapshotTrendSummary.contractValueDelta >= 0 ? "▲" : "▼"}{" "}
                    {Math.abs(snapshotTrendSummary.contractValueDelta).toFixed(1)}pp
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-sm">
                <span className="text-slate-500">At-Risk Systems</span>
                <span className="font-semibold text-amber-700">
                  {formatNumber(snapshotTrendSummary.latestCooNtNr)}
                </span>
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {snapshotTrendRows.length === 0 ? (
            <p className="text-sm text-slate-600">No snapshots logged yet.</p>
          ) : (
            <div className="space-y-1">
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={snapshotTrendRows}
                    margin={{ top: 8, right: 48, left: 8, bottom: 4 }}
                  >
                    <defs>
                      <linearGradient id="snTrendReportingGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0f766e" stopOpacity={0.18} />
                        <stop offset="95%" stopColor="#0f766e" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="snTrendContractGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#1d4ed8" stopOpacity={0.1} />
                        <stop offset="95%" stopColor="#1d4ed8" stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="#e2e8f0"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11 }}
                      axisLine={{ stroke: "#cbd5e1" }}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="pct"
                      domain={snapshotTrendSummary?.pctDomain ?? [0, 100]}
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v: number) => `${v}%`}
                      axisLine={false}
                      tickLine={false}
                      width={44}
                    />
                    <YAxis
                      yAxisId="count"
                      orientation="right"
                      tick={{ fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={36}
                      allowDecimals={false}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload || payload.length === 0) return null;
                        const row = payload[0]?.payload;
                        if (!row) return null;
                        return (
                          <div className="rounded-lg border bg-white px-3 py-2.5 shadow-lg text-xs space-y-1.5 min-w-[220px]">
                            <p className="font-medium text-slate-700 pb-0.5">
                              {row.timestamp}
                            </p>
                            <div className="space-y-1 border-t pt-1.5">
                              <div className="flex justify-between gap-4">
                                <span className="text-slate-500">Reporting Rate</span>
                                <span className="font-semibold text-teal-700">
                                  {row.reportingPercent !== null
                                    ? `${row.reportingPercent.toFixed(1)}%`
                                    : "—"}
                                  {row.reportingDelta !== null && (
                                    <span
                                      className={
                                        row.reportingDelta >= 0
                                          ? "text-emerald-600 ml-1"
                                          : "text-red-600 ml-1"
                                      }
                                    >
                                      {row.reportingDelta >= 0 ? "+" : ""}
                                      {row.reportingDelta.toFixed(1)}pp
                                    </span>
                                  )}
                                </span>
                              </div>
                              <div className="flex justify-between gap-4">
                                <span className="text-slate-500">Contract Value</span>
                                <span className="font-semibold text-blue-700">
                                  {row.contractValueReportingPercent !== null
                                    ? `${row.contractValueReportingPercent.toFixed(1)}%`
                                    : "—"}
                                </span>
                              </div>
                              <div className="flex justify-between gap-4">
                                <span className="text-slate-500">
                                  At-Risk (Not Transferred)
                                </span>
                                <span className="font-semibold text-amber-700">
                                  {formatNumber(row.cooNotTransferredNotReporting)} systems
                                </span>
                              </div>
                              <div className="flex justify-between gap-4 border-t pt-1">
                                <span className="text-slate-400">Portfolio</span>
                                <span className="text-slate-500">
                                  {formatNumber(row.reportingSystems)} /{" "}
                                  {formatNumber(row.totalSystems)} systems
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      }}
                    />
                    {snapshotTrendSummary &&
                      snapshotTrendSummary.pctDomain[0] <= 95 &&
                      snapshotTrendSummary.pctDomain[1] >= 95 && (
                        <ReferenceLine
                          yAxisId="pct"
                          y={95}
                          stroke="#94a3b8"
                          strokeDasharray="4 4"
                          label={{
                            value: "95% target",
                            position: "insideTopRight",
                            fontSize: 10,
                            fill: "#94a3b8",
                          }}
                        />
                      )}
                    <Area
                      yAxisId="pct"
                      type="monotone"
                      dataKey="reportingPercent"
                      name="Reporting Rate (%)"
                      fill="url(#snTrendReportingGrad)"
                      stroke="#0f766e"
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: "#0f766e", strokeWidth: 0 }}
                      activeDot={{
                        r: 5,
                        fill: "#0f766e",
                        strokeWidth: 2,
                        stroke: "#fff",
                      }}
                    />
                    <Area
                      yAxisId="pct"
                      type="monotone"
                      dataKey="contractValueReportingPercent"
                      name="Contract Value Reporting (%)"
                      fill="url(#snTrendContractGrad)"
                      stroke="#1d4ed8"
                      strokeWidth={1.5}
                      strokeDasharray="6 3"
                      dot={false}
                      activeDot={{
                        r: 4,
                        fill: "#1d4ed8",
                        strokeWidth: 2,
                        stroke: "#fff",
                      }}
                    />
                    <Bar
                      yAxisId="count"
                      dataKey="cooNotTransferredNotReporting"
                      name="At-Risk Systems (count)"
                      fill="#f59e0b"
                      fillOpacity={0.65}
                      radius={[2, 2, 0, 0]}
                      maxBarSize={20}
                    />
                    <Legend
                      iconType="circle"
                      wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              {snapshotTrendRows.length >= 2 && (
                <p className="text-[11px] text-slate-400 pl-12">
                  pp = percentage points &middot; {snapshotTrendRows.length} snapshots
                  from {snapshotTrendRows[0]!.label} to{" "}
                  {snapshotTrendRows[snapshotTrendRows.length - 1]!.label}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly Movement Tracker</CardTitle>
          <CardDescription>
            Tracks monthly movement into and out of{" "}
            <span className="font-medium">{COO_TARGET_STATUS}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {monthlySnapshotTransitions.length === 0 ? (
            <p className="text-sm text-slate-600">
              Need snapshots across at least 2 different months to calculate
              transitions.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead>Moved Into Status</TableHead>
                  <TableHead>Moved In From</TableHead>
                  <TableHead>Moved Out of Status</TableHead>
                  <TableHead>Moved Out To</TableHead>
                  <TableHead>Net Change</TableHead>
                  <TableHead>Ending Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {monthlySnapshotTransitions.map((item) => (
                  <TableRow key={item.monthKey}>
                    <TableCell className="font-medium">{item.monthLabel}</TableCell>
                    <TableCell>{formatNumber(item.movedIn)}</TableCell>
                    <TableCell className="max-w-[320px] whitespace-normal">
                      {item.movedInBreakdown}
                    </TableCell>
                    <TableCell>{formatNumber(item.movedOut)}</TableCell>
                    <TableCell className="max-w-[320px] whitespace-normal">
                      {item.movedOutBreakdown}
                    </TableCell>
                    <TableCell
                      className={
                        item.net < 0
                          ? "text-rose-700"
                          : item.net > 0
                            ? "text-emerald-700"
                            : ""
                      }
                    >
                      {formatNumber(item.net)}
                    </TableCell>
                    <TableCell>{formatNumber(item.endingCount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Vertical Snapshot Log</CardTitle>
              <CardDescription>
                Each click of <span className="font-medium">Log Snapshot</span>{" "}
                creates a new dated column.
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onCreateLogEntry}>
                Log Snapshot
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClearLogs}
                disabled={logEntries.length === 0}
              >
                Clear Logs
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {snapshotLogColumns.length === 0 ? (
            <p className="text-sm text-slate-600">No snapshots logged yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Metric</TableHead>
                  {snapshotLogColumns.map((entry) => (
                    <TableHead key={entry.id}>
                      <div className="flex min-w-[130px] flex-col gap-1">
                        <span>
                          {entry.createdAt.toLocaleDateString()}{" "}
                          {entry.createdAt.toLocaleTimeString()}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-fit px-2 text-rose-700 hover:text-rose-800"
                          onClick={() => onDeleteLogEntry(entry.id)}
                        >
                          <Trash2 className="mr-1 h-3.5 w-3.5" />
                          Delete
                        </Button>
                      </div>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshotMetricRows.map((metric) => {
                  if (metric.kind === "section") {
                    const sectionClass =
                      metric.sectionTone === "blue"
                        ? "bg-blue-50 text-blue-900"
                        : metric.sectionTone === "emerald"
                          ? "bg-emerald-50 text-emerald-900"
                          : "bg-slate-100 text-slate-900";
                    return (
                      <TableRow key={metric.label} className={sectionClass}>
                        <TableCell
                          colSpan={snapshotLogColumns.length + 1}
                          className="font-semibold uppercase tracking-wide text-xs"
                        >
                          {metric.label}
                        </TableCell>
                      </TableRow>
                    );
                  }

                  const labelClass =
                    metric.level === 1 ? "pl-7 text-slate-700" : "text-slate-900";
                  const valueClass =
                    metric.metricTone === "warn"
                      ? "text-amber-700 font-semibold"
                      : metric.metricTone === "neutral"
                        ? "text-slate-700"
                        : "text-slate-900";

                  return (
                    <TableRow key={metric.label}>
                      <TableCell className={`font-medium ${labelClass}`}>
                        {metric.level === 1 ? (
                          <span className="mr-2 text-slate-400">↳</span>
                        ) : null}
                        {metric.label}
                      </TableCell>
                      {snapshotLogColumns.map((entry) => (
                        <TableCell
                          key={`${entry.id}-${metric.label}`}
                          className={valueClass}
                        >
                          {metric.value(entry)}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            REC Performance Eval Snapshot by Contract
          </CardTitle>
          <CardDescription>
            Delivery Year {SNAPSHOT_REC_PERFORMANCE_DELIVERY_YEAR_LABEL}. Shows
            only contracts with delivery obligations in that year, including
            unallocated shortfall, required to avoid shortfall, delivered so
            far, and delivered percentage.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {snapshotLogColumns.length === 0 ? (
            <p className="text-sm text-slate-600">No snapshots logged yet.</p>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between text-xs text-slate-600">
                <span>
                  Showing contracts {formatNumber(snapshotContractStartIndex + 1)}-
                  {formatNumber(
                    Math.min(snapshotContractEndIndex, snapshotContractIds.length),
                  )}{" "}
                  of {formatNumber(snapshotContractIds.length)}
                </span>
                <span>
                  Page {formatNumber(snapshotContractCurrentPage)} of{" "}
                  {formatNumber(snapshotContractTotalPages)}
                </span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contract ID</TableHead>
                    {snapshotLogColumns.map((entry) => (
                      <TableHead key={`contract-snapshot-${entry.id}`}>
                        <div className="min-w-[180px]">
                          {entry.createdAt.toLocaleDateString()}{" "}
                          {entry.createdAt.toLocaleTimeString()}
                        </div>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleSnapshotContractIds.map((contractId) => (
                    <TableRow key={`snapshot-contract-${contractId}`}>
                      <TableCell className="font-medium">{contractId}</TableCell>
                      {snapshotLogColumns.map((entry) => {
                        const metric = snapshotContractMetricsByLogId
                          .get(entry.id)
                          ?.get(contractId);
                        return (
                          <TableCell key={`${entry.id}-${contractId}`}>
                            <div className="space-y-0.5 text-xs leading-5 text-slate-700">
                              <p>
                                Unallocated:{" "}
                                {formatNumber(metric?.unallocatedShortfallRecs ?? 0)}
                              </p>
                              <p>
                                Required:{" "}
                                {formatNumber(metric?.requiredToAvoidShortfallRecs ?? 0)}
                              </p>
                              <p>
                                Delivered:{" "}
                                {formatNumber(
                                  metric?.deliveredTowardShortfallRecs ?? 0,
                                )}
                              </p>
                              <p>
                                Delivered %:{" "}
                                {formatPercent(metric?.deliveredPercentOfRequired ?? null)}
                              </p>
                            </div>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSnapshotContractPage((page) => Math.max(1, page - 1))
                  }
                  disabled={snapshotContractCurrentPage <= 1}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSnapshotContractPage((page) =>
                      Math.min(snapshotContractTotalPages, page + 1),
                    )
                  }
                  disabled={snapshotContractCurrentPage >= snapshotContractTotalPages}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AskAiPanel
        moduleKey="solar-rec-snapshot-log"
        title="Ask AI about snapshot log trends"
        contextGetter={() => ({
          logEntryCount: logEntries.length,
          latestColumns: snapshotLogColumns.slice(0, 6).map((col) => ({
            id: col.id,
            createdAt: col.createdAt
              ? col.createdAt.toISOString().slice(0, 10)
              : null,
            totalSystems: col.totalSystems,
            reportingSystems: col.reportingSystems,
            reportingPercent: col.reportingPercent,
          })),
          trendSummary: snapshotTrendSummary,
          trendRows: snapshotTrendRows.map((r) => ({
            label: r.label,
            reportingPercent: r.reportingPercent,
            contractValueReportingPercent: r.contractValueReportingPercent,
            reportingDelta: r.reportingDelta,
            cooNotTransferredNotReporting: r.cooNotTransferredNotReporting,
          })),
          monthlyTransitionSummary:
            monthlySnapshotTransitions.length > 0
              ? {
                  months: monthlySnapshotTransitions.length,
                  latestMonthLabel:
                    monthlySnapshotTransitions[
                      monthlySnapshotTransitions.length - 1
                    ]?.monthLabel ?? null,
                }
              : null,
        })}
      />
    </div>
  );
});
