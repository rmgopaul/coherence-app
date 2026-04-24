/**
 * Forecast tab.
 *
 * Extracted from `SolarRecDashboard.tsx` in Phase 9a. This is the
 * smallest and most self-contained of the three REC performance
 * spine tabs — it owns:
 *   - the energy-year constants (FORECAST_EY_START_YEAR etc.),
 *   - the `forecastProjections` memo (which joins the shared
 *     `performanceSourceRows` against each system's annual production
 *     estimate + GATS meter-read baseline to project the remaining
 *     RECs in the current energy year), and
 *   - the `forecastSummary` KPI memo.
 *
 * `performanceSourceRows`, `annualProductionByTrackingId`,
 * `generationBaselineByTrackingId`, and `systems` all stay in the
 * parent because the Performance Evaluation + Snapshot Log tabs and
 * the `createLogEntry` snapshot builder also consume them. They flow
 * into this component as props so the forecast memo can compute
 * cleanly on mount without re-running any of the parent's 100+ other
 * memos.
 */

import { memo, useMemo, useState } from "react";
import { AskAiPanel } from "@/components/AskAiPanel";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildCsv,
  timestampForCsvFileName,
  triggerCsvDownload,
} from "@/solar-rec-dashboard/lib/csvIo";
import {
  calculateExpectedWhForRange,
  buildRecReviewDeliveryYearLabel,
  deriveRecPerformanceThreeYearValues,
  formatNumber,
} from "@/solar-rec-dashboard/lib/helpers";
import type {
  AnnualProductionProfile,
  GenerationBaseline,
  PerformanceSourceRow,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Energy-year constants
// ---------------------------------------------------------------------------
//
// Energy year runs May 1 – April 30. The label is derived once per
// module load from the current date: after May 31 we shift to the
// next energy year. These are effectively constants for the lifetime
// of the session — reloading the tab does NOT recompute them (the
// user reloads the page to get a new energy year on June 1).
// ---------------------------------------------------------------------------

const FORECAST_NOW = new Date();
const FORECAST_EY_START_YEAR =
  FORECAST_NOW.getMonth() >= 5 // June (0-indexed: 5) or later
    ? FORECAST_NOW.getFullYear() // e.g., June 2026 → EY 2026-2027
    : FORECAST_NOW.getFullYear() - 1; // e.g., April 2026 → EY 2025-2026
const FORECAST_EY_END_YEAR = FORECAST_EY_START_YEAR + 1;
const FORECAST_EY_LABEL = `${FORECAST_EY_START_YEAR}-${FORECAST_EY_END_YEAR}`;
const FORECAST_ENERGY_YEAR_END = new Date(FORECAST_EY_END_YEAR, 3, 30); // April 30
const FORECAST_FLOOR_DATE = new Date(FORECAST_EY_START_YEAR - 1, 5, 1); // June 1, two years before end

// ---------------------------------------------------------------------------
// Row + props shapes
// ---------------------------------------------------------------------------

type ForecastContractRow = {
  contract: string;
  systemsTotal: number;
  systemsReporting: number;
  requiredRecs: number;
  baselineRollingAvg: number;
  revisedRollingAvgReporting: number;
  revisedRollingAvgAll: number;
  delPercent: number | null;
  gapReporting: number;
  gapAll: number;
};

export interface ForecastTabProps {
  performanceSourceRows: PerformanceSourceRow[];
  systems: SystemRecord[];
  annualProductionByTrackingId: Map<string, AnnualProductionProfile>;
  generationBaselineByTrackingId: Map<string, GenerationBaseline>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function AuditStat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded border p-2 ${
        emphasis
          ? "border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40"
          : "border-amber-200 bg-white/50 dark:border-amber-900 dark:bg-black/20"
      }`}
    >
      <div className="text-muted-foreground">{label}</div>
      <div
        className={`font-mono font-semibold ${
          emphasis ? "text-rose-700 dark:text-rose-300" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export default memo(function ForecastTab(props: ForecastTabProps) {
  const {
    performanceSourceRows,
    systems,
    annualProductionByTrackingId,
    generationBaselineByTrackingId,
  } = props;

  // Transfer-history audit: fetched on-demand when the user clicks the
  // "Audit transfer history" button. Surfaces exact-key duplicates
  // (ingest-dedup miss) and near-duplicates (same unit/date/qty with
  // different transactionIds — GATS re-export renumbering).
  const [showAudit, setShowAudit] = useState(false);
  const scopeQuery = trpc.solarRecDashboard.getScopeId.useQuery(undefined, {
    staleTime: Infinity,
    retry: 1,
  });
  const scopeId = scopeQuery.data?.scopeId ?? null;
  const auditQuery = trpc.solarRecDashboard.debugTransferHistoryRaw.useQuery(
    { scopeId: scopeId ?? "" },
    { enabled: false, retry: 1 }
  );

  // Per-system delivery breakdown: user types a tracking ID / unitId
  // and sees the full DY1/DY2/DY3 trace.
  const [systemLookupInput, setSystemLookupInput] = useState("");
  const [systemLookupSubmitted, setSystemLookupSubmitted] = useState<
    string | null
  >(null);
  const systemBreakdownQuery =
    trpc.solarRecDashboard.debugSystemDeliveryBreakdown.useQuery(
      {
        scopeId: scopeId ?? "",
        trackingId: systemLookupSubmitted ?? "",
      },
      {
        enabled: !!scopeId && !!systemLookupSubmitted,
        retry: 1,
        staleTime: 60_000,
      }
    );

  // Use the same 3-year rolling logic as REC Performance Eval to match
  // baseline numbers. For each system: find the delivery year matching
  // FORECAST_EY_LABEL, require targetYearIndex >= 2 (3rd year or
  // later), compute the rolling average. Then project the remaining
  // RECs in the current energy year using the annual production
  // estimate from the GATS meter-read date forward.
  const forecastProjections = useMemo<ForecastContractRow[]>(() => {
    if (performanceSourceRows.length === 0) return [];

    const contractMap = new Map<
      string,
      {
        contract: string;
        systemsTotal: number;
        systemsReporting: number;
        requiredRecs: number;
        baselineRollingAvg: number;
        revisedRollingAvgReporting: number;
        revisedRollingAvgAll: number;
      }
    >();

    for (const sourceRow of performanceSourceRows) {
      const targetYearIndex = sourceRow.years.findIndex((year) => {
        const label = buildRecReviewDeliveryYearLabel(
          year.startDate,
          year.endDate,
          year.startRaw,
          year.endRaw,
        );
        return label === FORECAST_EY_LABEL;
      });
      const recWindow = deriveRecPerformanceThreeYearValues(
        sourceRow,
        targetYearIndex,
      );
      if (!recWindow) continue; // Must be in 3rd delivery year or later

      const dy1Val = recWindow.deliveryYearOne;
      const dy2Val = recWindow.deliveryYearTwo;
      const dy3Actual = recWindow.deliveryYearThree;
      const obligation = recWindow.expectedRecs;
      const baselineRollingAvg = recWindow.rollingAverage;

      const trackingId = sourceRow.trackingSystemRefId;
      const profile = annualProductionByTrackingId.get(trackingId);
      const baseline = generationBaselineByTrackingId.get(trackingId);
      const sys = systems.find(
        (s) => s.trackingSystemRefId === trackingId,
      );
      const isReporting = sys?.isReporting ?? false;

      // Determine start date: latest meter reading from GATS, clamped
      // to the energy-year floor.
      let meterReadDate = baseline?.date ?? null;
      if (meterReadDate && meterReadDate < FORECAST_FLOOR_DATE) {
        meterReadDate = FORECAST_FLOOR_DATE;
      }

      // Project RECs for remainder of the energy year.
      let projectedRecsForSystem = 0;
      if (profile && meterReadDate) {
        const endDate = FORECAST_ENERGY_YEAR_END;
        if (meterReadDate < endDate) {
          const expectedWh = calculateExpectedWhForRange(
            profile.monthlyKwh,
            meterReadDate,
            endDate,
          );
          if (expectedWh !== null && expectedWh > 0) {
            projectedRecsForSystem = Math.floor(expectedWh / 1000 / 1000);
          }
        }
      } else if (profile && !meterReadDate) {
        const expectedWh = calculateExpectedWhForRange(
          profile.monthlyKwh,
          FORECAST_FLOOR_DATE,
          FORECAST_ENERGY_YEAR_END,
        );
        if (expectedWh !== null && expectedWh > 0) {
          projectedRecsForSystem = Math.floor(expectedWh / 1000 / 1000);
        }
      }

      // Revised DY3: plug projected RECs into the current year's
      // delivery, then recompute the rolling average. This avoids
      // double-counting by running the projected generation through
      // the same /3 averaging.
      const dy3RevisedReporting =
        isReporting && meterReadDate
          ? dy3Actual + projectedRecsForSystem
          : dy3Actual;
      const dy3RevisedAll = dy3Actual + projectedRecsForSystem;

      const revisedRollingAvgReporting = Math.floor(
        (dy1Val + dy2Val + dy3RevisedReporting) / 3,
      );
      const revisedRollingAvgAll = Math.floor(
        (dy1Val + dy2Val + dy3RevisedAll) / 3,
      );

      // Accumulate by contract
      const contractId = sourceRow.contractId;
      const existing = contractMap.get(contractId) ?? {
        contract: contractId,
        systemsTotal: 0,
        systemsReporting: 0,
        requiredRecs: 0,
        baselineRollingAvg: 0,
        revisedRollingAvgReporting: 0,
        revisedRollingAvgAll: 0,
      };

      existing.systemsTotal++;
      if (isReporting) existing.systemsReporting++;
      existing.requiredRecs += obligation;
      existing.baselineRollingAvg += baselineRollingAvg;
      existing.revisedRollingAvgReporting += revisedRollingAvgReporting;
      existing.revisedRollingAvgAll += revisedRollingAvgAll;
      contractMap.set(contractId, existing);
    }

    return Array.from(contractMap.values())
      .map((c) => ({
        ...c,
        delPercent:
          c.requiredRecs > 0 ? (c.baselineRollingAvg / c.requiredRecs) * 100 : null,
        gapReporting: c.revisedRollingAvgReporting - c.requiredRecs,
        gapAll: c.revisedRollingAvgAll - c.requiredRecs,
      }))
      .sort((a, b) => a.gapReporting - b.gapReporting);
  }, [
    performanceSourceRows,
    annualProductionByTrackingId,
    generationBaselineByTrackingId,
    systems,
  ]);

  const forecastSummary = useMemo(() => {
    const total = forecastProjections.length;
    const totalRevisedReporting = forecastProjections.reduce(
      (a, c) => a + c.revisedRollingAvgReporting,
      0,
    );
    const totalRevisedAll = forecastProjections.reduce(
      (a, c) => a + c.revisedRollingAvgAll,
      0,
    );
    const atRisk = forecastProjections.filter((c) => c.gapReporting < 0).length;
    return { total, totalRevisedReporting, totalRevisedAll, atRisk };
  }, [forecastProjections]);

  return (
    <div className="space-y-4 mt-4">
      <Card className="border-sky-200 bg-sky-50/30">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            REC Production Forecast — Energy Year {FORECAST_EY_LABEL}
          </CardTitle>
          <CardDescription>
            Projected additional RECs per contract based on estimated production
            from each system&apos;s latest GATS meter read date through April 30,{" "}
            {FORECAST_EY_END_YEAR}. Uses Annual Production Estimates with daily
            pro-rata. Floor date: June 1, {FORECAST_EY_START_YEAR - 1}. 1 REC =
            1,000 kWh (floored per system). Floor date advances each energy
            year (always June 1 of the prior energy year).
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Contracts</CardDescription>
            <CardTitle className="text-2xl">{forecastSummary.total}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/30">
          <CardHeader>
            <CardDescription>Revised Avg (Reporting)</CardDescription>
            <CardTitle className="text-2xl text-emerald-800 dark:text-emerald-400">
              {formatNumber(forecastSummary.totalRevisedReporting)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="border-sky-200 bg-sky-50/50 dark:border-sky-800 dark:bg-sky-950/30">
          <CardHeader>
            <CardDescription>Revised Avg (All Sites)</CardDescription>
            <CardTitle className="text-2xl text-sky-800 dark:text-sky-400">
              {formatNumber(forecastSummary.totalRevisedAll)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card
          className={
            forecastSummary.atRisk > 0
              ? "border-rose-200 bg-rose-50/50 dark:border-rose-800 dark:bg-rose-950/30"
              : "border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/30"
          }
        >
          <CardHeader>
            <CardDescription>Contracts At Risk</CardDescription>
            <CardTitle className="text-2xl">{forecastSummary.atRisk}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card className="border-amber-200 bg-amber-50/30 dark:border-amber-900 dark:bg-amber-950/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Transfer History Audit
              </CardTitle>
              <CardDescription className="text-xs">
                Check the active transferHistory batch for duplicates that
                would inflate Delivered RECs and therefore Revised Avg.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!scopeId || auditQuery.isFetching}
              onClick={async () => {
                setShowAudit(true);
                const result = await auditQuery.refetch();
                if (result.error) {
                  const msg =
                    result.error instanceof Error
                      ? result.error.message
                      : String(result.error);
                  toast.error(`Audit failed: ${msg}`);
                  return;
                }
                const d = result.data;
                if (!d) {
                  toast.error("Audit returned no data");
                  return;
                }
                if (!d.activeBatchId) {
                  toast.info("No active transferHistory batch");
                  return;
                }
                const extra = d.exactDupExtraRows + d.nearDupExtraRows;
                if (extra === 0) {
                  toast.success(
                    `No duplicates found in ${d.totalRowCount.toLocaleString()} rows`
                  );
                } else {
                  toast.warning(
                    `${extra.toLocaleString()} duplicate-equivalent rows detected`
                  );
                }
              }}
            >
              {auditQuery.isFetching ? "Auditing…" : "Audit transfer history"}
            </Button>
          </div>
        </CardHeader>
        {showAudit ? (
          <CardContent className="space-y-3 text-xs">
            {!scopeId ? (
              <p className="text-muted-foreground">
                Waiting for scope… (user not yet resolved)
              </p>
            ) : auditQuery.isFetching ? (
              <p className="text-muted-foreground">
                Running audit — this can take a few seconds on the full batch.
              </p>
            ) : auditQuery.error ? (
              <div className="rounded border border-rose-300 bg-rose-50 p-2 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
                <div className="font-medium">Audit request failed</div>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono">
                  {auditQuery.error instanceof Error
                    ? auditQuery.error.message
                    : String(auditQuery.error)}
                </pre>
              </div>
            ) : !auditQuery.data ? (
              <p className="text-muted-foreground">
                Query returned no data. Open devtools Network tab and look for
                the debugTransferHistoryRaw request to inspect the response.
              </p>
            ) : !auditQuery.data.activeBatchId ? (
              <p className="text-muted-foreground">
                No active transferHistory batch for this scope.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <AuditStat
                    label="Active Batch"
                    value={auditQuery.data.activeBatchId.slice(0, 12) + "…"}
                  />
                  <AuditStat
                    label="Rows in Batch"
                    value={auditQuery.data.totalRowCount.toLocaleString()}
                  />
                  <AuditStat
                    label="Exact-Key Dup Rows"
                    value={auditQuery.data.exactDupExtraRows.toLocaleString()}
                    emphasis={auditQuery.data.exactDupExtraRows > 0}
                  />
                  <AuditStat
                    label="Near-Dup Rows"
                    value={auditQuery.data.nearDupExtraRows.toLocaleString()}
                    emphasis={auditQuery.data.nearDupExtraRows > 0}
                  />
                </div>

                {auditQuery.data.batch ? (
                  <div className="rounded border border-amber-200 bg-white/50 p-2 dark:border-amber-900 dark:bg-black/20">
                    <div className="font-medium">Batch metadata</div>
                    <div className="text-muted-foreground">
                      merge={auditQuery.data.batch.mergeStrategy}, status=
                      {auditQuery.data.batch.status}, rowCount=
                      {auditQuery.data.batch.rowCount?.toLocaleString() ?? "—"},
                      created={auditQuery.data.batch.createdAt ?? "—"}
                    </div>
                  </div>
                ) : null}

                {auditQuery.data.files.length > 0 ? (
                  <div className="rounded border border-amber-200 bg-white/50 p-2 dark:border-amber-900 dark:bg-black/20">
                    <div className="font-medium">
                      Files contributing to this batch (
                      {auditQuery.data.files.length})
                    </div>
                    <ul className="mt-1 space-y-0.5 text-muted-foreground">
                      {auditQuery.data.files.map((f, i) => (
                        <li key={i}>
                          {f.fileName} —{" "}
                          {f.sizeBytes
                            ? `${(f.sizeBytes / 1024).toFixed(1)} KB`
                            : "? KB"}
                          {f.rowCount !== null
                            ? ` · ${f.rowCount.toLocaleString()} rows`
                            : ""}{" "}
                          · {f.createdAt ?? "?"}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {auditQuery.data.topNearDupes.length > 0 ? (
                  <div className="rounded border border-amber-300 bg-amber-100/50 p-2 dark:border-amber-800 dark:bg-amber-900/30">
                    <div className="font-medium">
                      Top near-duplicates (same unit/date/qty, different
                      transactionIds):
                    </div>
                    <div className="text-muted-foreground">
                      If <code>Transferors</code> and <code>Transferees</code> are
                      both <code>1</code>, the rows are a single transfer
                      recorded N times — summing qty over-counts by N×. If
                      they&apos;re &gt;1, the rows are distinct sub-transfers
                      and summing is correct.
                    </div>
                    <div className="mt-1 overflow-x-auto">
                      <table className="min-w-full">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="pr-3 text-left">Unit</th>
                            <th className="pr-3 text-left">Completion Date</th>
                            <th className="pr-3 text-right">Qty</th>
                            <th className="pr-3 text-right">Rows</th>
                            <th className="pr-3 text-right">TxIDs</th>
                            <th className="pr-3 text-right">Transferors</th>
                            <th className="pr-3 text-right">Transferees</th>
                            <th className="pr-3 text-left">Sample Transferor</th>
                            <th className="text-left">Sample Transferee</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditQuery.data.topNearDupes.map((d, i) => {
                            const singleCounterparty =
                              d.distinctTransferors === 1 &&
                              d.distinctTransferees === 1;
                            return (
                              <tr
                                key={i}
                                className={
                                  singleCounterparty
                                    ? "text-rose-800 dark:text-rose-300"
                                    : ""
                                }
                              >
                                <td className="pr-3">{d.unitId ?? ""}</td>
                                <td className="pr-3">
                                  {d.transferCompletionDate ?? ""}
                                </td>
                                <td className="pr-3 text-right">
                                  {d.quantity?.toLocaleString() ?? ""}
                                </td>
                                <td className="pr-3 text-right">{d.count}</td>
                                <td className="pr-3 text-right">
                                  {d.distinctTransactionIds}
                                </td>
                                <td className="pr-3 text-right">
                                  {d.distinctTransferors}
                                </td>
                                <td className="pr-3 text-right">
                                  {d.distinctTransferees}
                                </td>
                                <td
                                  className="pr-3 max-w-[16ch] truncate"
                                  title={d.sampleTransferor ?? ""}
                                >
                                  {d.sampleTransferor ?? ""}
                                </td>
                                <td
                                  className="max-w-[16ch] truncate"
                                  title={d.sampleTransferee ?? ""}
                                >
                                  {d.sampleTransferee ?? ""}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                {auditQuery.data.topExactDupes.length > 0 ? (
                  <div className="rounded border border-rose-300 bg-rose-100/50 p-2 dark:border-rose-800 dark:bg-rose-900/30">
                    <div className="font-medium">
                      Top exact-key duplicates (ingest dedup miss):
                    </div>
                    <div className="mt-1 overflow-x-auto">
                      <table className="min-w-full">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="pr-3 text-left">TxID</th>
                            <th className="pr-3 text-left">Unit</th>
                            <th className="pr-3 text-left">Date</th>
                            <th className="pr-3 text-right">Qty</th>
                            <th className="text-right">Rows</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditQuery.data.topExactDupes.map((d, i) => (
                            <tr key={i}>
                              <td className="pr-3">{d.transactionId ?? ""}</td>
                              <td className="pr-3">{d.unitId ?? ""}</td>
                              <td className="pr-3">
                                {d.transferCompletionDate ?? ""}
                              </td>
                              <td className="pr-3 text-right">
                                {d.quantity?.toLocaleString() ?? ""}
                              </td>
                              <td className="text-right">{d.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                <div className="text-muted-foreground">
                  runner={auditQuery.data._runnerVersion}, checkpoint=
                  {auditQuery.data._checkpoint}
                </div>
              </>
            )}
          </CardContent>
        ) : null}
      </Card>

      <Card className="border-slate-200 bg-slate-50/30 dark:border-slate-800 dark:bg-slate-900/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Per-System Delivery Breakdown
              </CardTitle>
              <CardDescription className="text-xs">
                Enter a tracking ID / GATS Unit ID (e.g.{" "}
                <code>NON258210</code>) to see the transfer rows,
                energy-year aggregation, schedule, and DY1/DY2/DY3 trace for
                the current energy year.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={systemLookupInput}
                onChange={(e) => setSystemLookupInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && systemLookupInput.trim()) {
                    setSystemLookupSubmitted(systemLookupInput.trim());
                  }
                }}
                placeholder="NON258210"
                className="h-7 rounded border border-slate-300 bg-white px-2 text-xs font-mono dark:border-slate-700 dark:bg-black/40"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={!scopeId || !systemLookupInput.trim()}
                onClick={() => {
                  setSystemLookupSubmitted(systemLookupInput.trim());
                }}
              >
                {systemBreakdownQuery.isFetching ? "Looking up…" : "Look up"}
              </Button>
            </div>
          </div>
        </CardHeader>
        {systemLookupSubmitted ? (
          <CardContent className="space-y-3 text-xs">
            {systemBreakdownQuery.isFetching ? (
              <p className="text-muted-foreground">
                Loading breakdown for {systemLookupSubmitted}…
              </p>
            ) : systemBreakdownQuery.error ? (
              <div className="rounded border border-rose-300 bg-rose-50 p-2 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
                <div className="font-medium">Breakdown request failed</div>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono">
                  {systemBreakdownQuery.error instanceof Error
                    ? systemBreakdownQuery.error.message
                    : String(systemBreakdownQuery.error)}
                </pre>
              </div>
            ) : !systemBreakdownQuery.data ? (
              <p className="text-muted-foreground">No data.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <div className="rounded border border-slate-200 bg-white/50 p-2 dark:border-slate-700 dark:bg-black/20">
                    <div className="text-muted-foreground">Tracking ID</div>
                    <div className="font-mono font-semibold">
                      {systemBreakdownQuery.data.trackingId}
                    </div>
                  </div>
                  <div className="rounded border border-slate-200 bg-white/50 p-2 dark:border-slate-700 dark:bg-black/20">
                    <div className="text-muted-foreground">Transfer Rows</div>
                    <div className="font-mono font-semibold">
                      {systemBreakdownQuery.data.transferRowCount.toLocaleString()}
                      {systemBreakdownQuery.data.truncated
                        ? " (showing first 200)"
                        : ""}
                    </div>
                  </div>
                  <div className="rounded border border-slate-200 bg-white/50 p-2 dark:border-slate-700 dark:bg-black/20">
                    <div className="text-muted-foreground">
                      First Transfer EY
                    </div>
                    <div className="font-mono font-semibold">
                      {systemBreakdownQuery.data.firstTransferEnergyYear ?? "—"}
                    </div>
                  </div>
                  <div className="rounded border border-slate-200 bg-white/50 p-2 dark:border-slate-700 dark:bg-black/20">
                    <div className="text-muted-foreground">Schedules</div>
                    <div className="font-mono font-semibold">
                      {systemBreakdownQuery.data.schedules.length}
                    </div>
                  </div>
                </div>

                {systemBreakdownQuery.data.duplicateTxIdRowCount > 0 ? (
                  <div className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                    <strong>
                      {systemBreakdownQuery.data.duplicateTxIdRowCount}
                    </strong>{" "}
                    duplicate-Transaction-ID row
                    {systemBreakdownQuery.data.duplicateTxIdRowCount === 1
                      ? ""
                      : "s"}{" "}
                    detected (excluded from all totals below). Excluded qty
                    net: <strong>
                      {systemBreakdownQuery.data.duplicateTxIdQtyExcluded.toLocaleString()}
                    </strong>
                    . Duplicates are struck through in the Transfer rows table
                    below.
                  </div>
                ) : null}

                {systemBreakdownQuery.data.dyWindows.map((w, i) => (
                  <div
                    key={i}
                    className={`rounded border p-2 ${
                      w.eligible
                        ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30"
                        : "border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/30"
                    }`}
                  >
                    <div className="font-medium">
                      DY window — contract {w.utilityContractNumber ?? "—"},
                      current EY {w.forecastEyLabel}
                    </div>
                    {!w.eligible ? (
                      <div className="text-muted-foreground">
                        Ineligible: {w.reason}
                      </div>
                    ) : (
                      <div className="mt-1 overflow-x-auto">
                        <table className="min-w-full">
                          <thead className="text-muted-foreground">
                            <tr>
                              <th className="pr-3 text-left">Year</th>
                              <th className="pr-3 text-left">Schedule Idx</th>
                              <th className="pr-3 text-left">EY</th>
                              <th className="pr-3 text-right">Required</th>
                              <th className="pr-3 text-right">
                                Delivered (transfers)
                              </th>
                              <th className="pr-3 text-right">Value</th>
                              <th className="text-left">Source</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[
                              { label: "DY1", ...w.dy1 },
                              { label: "DY2", ...w.dy2 },
                              { label: "DY3", ...w.dy3 },
                            ].map((d) => (
                              <tr key={d.label}>
                                <td className="pr-3 font-semibold">{d.label}</td>
                                <td className="pr-3">{d.yearIndex}</td>
                                <td className="pr-3">
                                  {d.energyYearStart ?? "—"}
                                </td>
                                <td className="pr-3 text-right">
                                  {d.required.toLocaleString()}
                                </td>
                                <td className="pr-3 text-right">
                                  {d.deliveredFromTransfers.toLocaleString()}
                                </td>
                                <td className="pr-3 text-right font-mono font-semibold">
                                  {d.value.toLocaleString()}
                                </td>
                                <td>{d.source}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="mt-1 text-muted-foreground">
                          actualDeliveryYearNumber=
                          {w.actualDeliveryYearNumber}, firstDeliveryYear=
                          {w.firstDeliveryYear}, rolling average=
                          <span className="font-mono font-semibold">
                            {" "}
                            {w.rollingAverage.toLocaleString()}
                          </span>
                          , expectedRecs={w.expectedRecs.toLocaleString()}
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {systemBreakdownQuery.data.energyYearAgg.length > 0 ? (
                  <div className="rounded border border-slate-200 bg-white/50 p-2 dark:border-slate-700 dark:bg-black/20">
                    <div className="font-medium">
                      Energy-year aggregation (CS → utility filter; +qty for
                      deliveries, −qty for reverses)
                    </div>
                    <div className="mt-1 overflow-x-auto">
                      <table className="min-w-full">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="pr-3 text-left">Energy Year</th>
                            <th className="pr-3 text-right">Contributing Rows</th>
                            <th className="text-right">Net Qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {systemBreakdownQuery.data.energyYearAgg.map((ey) => (
                            <tr key={ey.energyYearStart}>
                              <td className="pr-3">{ey.label}</td>
                              <td className="pr-3 text-right">{ey.rowCount}</td>
                              <td className="text-right font-mono">
                                {ey.netQty.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                {systemBreakdownQuery.data.schedules.map((s, i) => (
                  <div
                    key={i}
                    className="rounded border border-slate-200 bg-white/50 p-2 dark:border-slate-700 dark:bg-black/20"
                  >
                    <div className="font-medium">
                      Schedule B — contract {s.utilityContractNumber ?? "—"}{" "}
                      ({s.systemName ?? "—"})
                    </div>
                    <div className="mt-1 overflow-x-auto">
                      <table className="min-w-full">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="pr-3 text-left">Idx</th>
                            <th className="pr-3 text-left">Start</th>
                            <th className="pr-3 text-left">End</th>
                            <th className="pr-3 text-left">EY</th>
                            <th className="pr-3 text-right">Required</th>
                            <th className="pr-3 text-right">
                              Delivered (schedule)
                            </th>
                            <th className="text-right">
                              Delivered (transfers)
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.years.map((y) => (
                            <tr key={y.yearIndex}>
                              <td className="pr-3">{y.yearIndex}</td>
                              <td className="pr-3">{y.startDate ?? "—"}</td>
                              <td className="pr-3">{y.endDate ?? "—"}</td>
                              <td className="pr-3">{y.energyYearStart ?? "—"}</td>
                              <td className="pr-3 text-right">
                                {y.required.toLocaleString()}
                              </td>
                              <td className="pr-3 text-right">
                                {y.scheduleDelivered.toLocaleString()}
                              </td>
                              <td className="text-right font-mono">
                                {y.deliveredFromTransfers.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}

                {systemBreakdownQuery.data.transferRows.length > 0 ? (
                  <div className="rounded border border-slate-200 bg-white/50 p-2 dark:border-slate-700 dark:bg-black/20">
                    <div className="font-medium">
                      Transfer rows ({systemBreakdownQuery.data.transferRows.length}
                      {systemBreakdownQuery.data.truncated
                        ? ` of ${systemBreakdownQuery.data.transferRowCount}`
                        : ""}
                      )
                    </div>
                    <div className="mt-1 overflow-x-auto">
                      <table className="min-w-full">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="pr-3 text-left">TxID</th>
                            <th className="pr-3 text-left">Completion</th>
                            <th className="pr-3 text-left">Month/Year</th>
                            <th className="pr-3 text-right">Qty</th>
                            <th className="pr-3 text-right">Dir</th>
                            <th className="pr-3 text-right">EY</th>
                            <th className="pr-3 text-left">Transferor</th>
                            <th className="text-left">Transferee</th>
                          </tr>
                        </thead>
                        <tbody>
                          {systemBreakdownQuery.data.transferRows.map((r, j) => {
                            const rowClass = r.isDuplicate
                              ? "line-through text-amber-700 dark:text-amber-400"
                              : r.direction === 0
                                ? "text-muted-foreground"
                                : "";
                            return (
                              <tr key={j} className={rowClass}>
                                <td
                                  className="pr-3 font-mono"
                                  title={
                                    r.isDuplicate
                                      ? "Duplicate Transaction ID — excluded from totals"
                                      : undefined
                                  }
                                >
                                  {r.isDuplicate ? "⚠ " : ""}
                                  {r.transactionId ?? ""}
                                </td>
                                <td className="pr-3">{r.completionDate ?? ""}</td>
                                <td className="pr-3">{r.monthYear ?? ""}</td>
                                <td className="pr-3 text-right">
                                  {r.quantity?.toLocaleString() ?? ""}
                                </td>
                                <td className="pr-3 text-right">
                                  {r.direction === 1
                                    ? "+"
                                    : r.direction === -1
                                      ? "−"
                                      : "·"}
                                </td>
                                <td className="pr-3 text-right">
                                  {r.energyYear ?? ""}
                                </td>
                                <td
                                  className="pr-3 max-w-[14ch] truncate"
                                  title={r.transferor ?? ""}
                                >
                                  {r.transferor ?? ""}
                                </td>
                                <td
                                  className="max-w-[14ch] truncate"
                                  title={r.transferee ?? ""}
                                >
                                  {r.transferee ?? ""}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                <div className="text-muted-foreground">
                  runner={systemBreakdownQuery.data._runnerVersion}, checkpoint=
                  {systemBreakdownQuery.data._checkpoint}
                </div>
              </>
            )}
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">
                Projected REC Production by Contract
              </CardTitle>
              <CardDescription>
                <strong>Projection 1 (Reporting):</strong> Only sites reporting in
                the last 3 months. <strong>Projection 2 (All Sites):</strong> All
                eligible sites including non-reporting (using June 1,{" "}
                {FORECAST_EY_START_YEAR - 1} floor for missing dates).
              </CardDescription>
            </div>
            {forecastProjections.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const csv = buildCsv(
                    [
                      "contract",
                      "systems_total",
                      "systems_reporting",
                      "obligation_recs",
                      "baseline_rolling_avg",
                      "del_pct",
                      "revised_avg_reporting",
                      "revised_avg_all",
                      "gap_reporting",
                      "gap_all",
                    ],
                    forecastProjections.map((c) => ({
                      contract: c.contract,
                      systems_total: c.systemsTotal,
                      systems_reporting: c.systemsReporting,
                      obligation_recs: c.requiredRecs,
                      baseline_rolling_avg: c.baselineRollingAvg,
                      del_pct:
                        c.delPercent !== null ? c.delPercent.toFixed(1) : "",
                      revised_avg_reporting: c.revisedRollingAvgReporting,
                      revised_avg_all: c.revisedRollingAvgAll,
                      gap_reporting: c.gapReporting,
                      gap_all: c.gapAll,
                    })),
                  );
                  triggerCsvDownload(
                    `rec-forecast-ey${FORECAST_EY_LABEL}-${timestampForCsvFileName()}.csv`,
                    csv,
                  );
                }}
              >
                Export CSV
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {forecastProjections.length === 0 ? (
            <p className="text-sm text-slate-500 py-4 text-center">
              Scrape Schedule B PDFs, upload Transfer History, Account Solar
              Generation, and Annual Production Estimates to see forecasts.
            </p>
          ) : (
            <>
              <div className="h-80 rounded-md border border-slate-200 bg-white p-2 mb-4">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={forecastProjections}
                    margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="contract"
                      tick={{ fontSize: 10 }}
                      angle={-35}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="requiredRecs" fill="#94a3b8" name="Obligation" />
                    <Bar
                      dataKey="baselineRollingAvg"
                      fill="#16a34a"
                      name="Baseline 3-Yr Avg"
                    />
                    <Bar
                      dataKey="revisedRollingAvgReporting"
                      fill="#0ea5e9"
                      name="Revised Avg (Reporting)"
                    />
                    <Bar
                      dataKey="revisedRollingAvgAll"
                      fill="#8b5cf6"
                      name="Revised Avg (All)"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Contract</TableHead>
                      <TableHead className="text-right">Systems</TableHead>
                      <TableHead className="text-right">Reporting</TableHead>
                      <TableHead className="text-right">Obligation</TableHead>
                      <TableHead className="text-right">Baseline 3-Yr Avg</TableHead>
                      <TableHead className="text-right">Del. %</TableHead>
                      <TableHead className="text-right text-sky-700">
                        Revised Avg (Reporting)
                      </TableHead>
                      <TableHead className="text-right text-sky-700">%</TableHead>
                      <TableHead className="text-right text-violet-700">
                        Revised Avg (All)
                      </TableHead>
                      <TableHead className="text-right text-violet-700">%</TableHead>
                      <TableHead className="text-right">Gap (Reporting)</TableHead>
                      <TableHead className="text-right">Gap (All)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {forecastProjections.map((c) => {
                      const delPct =
                        c.delPercent !== null ? c.delPercent.toFixed(1) : "N/A";
                      const revisedPctReporting =
                        c.requiredRecs > 0
                          ? ((c.revisedRollingAvgReporting / c.requiredRecs) * 100).toFixed(
                              1,
                            )
                          : "N/A";
                      const revisedPctAll =
                        c.requiredRecs > 0
                          ? ((c.revisedRollingAvgAll / c.requiredRecs) * 100).toFixed(1)
                          : "N/A";
                      const gapReportingPositive = c.gapReporting >= 0;
                      const gapAllPositive = c.gapAll >= 0;
                      return (
                        <TableRow key={c.contract}>
                          <TableCell className="font-medium">{c.contract}</TableCell>
                          <TableCell className="text-right">{c.systemsTotal}</TableCell>
                          <TableCell className="text-right">{c.systemsReporting}</TableCell>
                          <TableCell className="text-right">
                            {formatNumber(c.requiredRecs)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatNumber(c.baselineRollingAvg)}
                          </TableCell>
                          <TableCell className="text-right">{delPct}%</TableCell>
                          <TableCell className="text-right font-medium text-sky-700 dark:text-sky-400">
                            {formatNumber(c.revisedRollingAvgReporting)}
                          </TableCell>
                          <TableCell className="text-right text-xs text-sky-600 dark:text-sky-500">
                            {revisedPctReporting}%
                          </TableCell>
                          <TableCell className="text-right font-medium text-violet-700 dark:text-violet-400">
                            {formatNumber(c.revisedRollingAvgAll)}
                          </TableCell>
                          <TableCell className="text-right text-xs text-violet-600 dark:text-violet-500">
                            {revisedPctAll}%
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge
                              variant="outline"
                              className={
                                gapReportingPositive
                                  ? "text-emerald-700 border-emerald-300 dark:text-emerald-400 dark:border-emerald-700"
                                  : "text-red-700 border-red-300 dark:text-red-400 dark:border-red-700"
                              }
                            >
                              {gapReportingPositive ? "+" : ""}
                              {formatNumber(c.gapReporting)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge
                              variant="outline"
                              className={
                                gapAllPositive
                                  ? "text-emerald-700 border-emerald-300 dark:text-emerald-400 dark:border-emerald-700"
                                  : "text-red-700 border-red-300 dark:text-red-400 dark:border-red-700"
                              }
                            >
                              {gapAllPositive ? "+" : ""}
                              {formatNumber(c.gapAll)}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AskAiPanel
        moduleKey="solar-rec-forecast"
        title="Ask AI about the REC forecast"
        contextGetter={() => ({
          summary: forecastSummary,
          sampleContracts: [...forecastProjections]
            .sort((a, b) => a.gapReporting - b.gapReporting)
            .slice(0, 20)
            .map((c) => ({
              contract: c.contract,
              systemsTotal: c.systemsTotal,
              systemsReporting: c.systemsReporting,
              requiredRecs: c.requiredRecs,
              baselineRollingAvg: c.baselineRollingAvg,
              revisedRollingAvgReporting: c.revisedRollingAvgReporting,
              revisedRollingAvgAll: c.revisedRollingAvgAll,
              delPercent: c.delPercent,
              gapReporting: c.gapReporting,
              gapAll: c.gapAll,
            })),
        })}
      />
    </div>
  );
});
