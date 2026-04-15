/**
 * REC Performance Evaluation tab.
 *
 * Extracted from `SolarRecDashboard.tsx` in Phase 9b. This is the
 * heaviest of the three REC performance spine tabs — it owns the
 * `recPerformanceEvaluation` model (the 3-year rolling average with
 * surplus allocation + drawdown accounting), the delivery-year /
 * contract selectors, and the filterable paginated results table.
 *
 * State that moves here (out of the parent):
 *   - `performanceContractId`, `performanceDeliveryYearKey`,
 *     `performancePreviousSurplusInput`,
 *     `performancePreviousDrawdownInput` — user inputs
 *   - `recPerformanceResultsPage`, `recPerfSortBy`, `recPerfSortDir`,
 *     `recPerfSearch`, `recPerfStatusFilter` — filter/sort/page state
 *   - `handleRecPerfSort`, `recPerfSortIndicator` — sort helpers
 *   - `performanceContractOptions`, `performanceDeliveryYearOptions`,
 *     `defaultPerformanceDeliveryYearKey`, `recPerformanceEvaluation`,
 *     `recPerformanceContractYearSummaryRows`,
 *     `recPerformanceContractYearSummaryTotals`,
 *     `filteredRecPerformanceRows`, `visibleRecPerformanceRows` — memos
 *   - Pagination clamp + filter-reset useEffects
 *
 * What stays in the parent: `performanceSourceRows` (the shared
 * input), which still feeds this tab plus the Snapshot Log and the
 * `createLogEntry` snapshot builder. Flows in as the single prop.
 */

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { clean, formatCurrency } from "@/lib/helpers";
import {
  buildCsv,
  timestampForCsvFileName,
  triggerCsvDownload,
} from "@/solar-rec-dashboard/lib/csvIo";
import {
  buildRecReviewDeliveryYearLabel,
  deriveRecPerformanceThreeYearValues,
  formatNumber,
  formatSignedNumber,
  parseNumber,
} from "@/solar-rec-dashboard/lib/helpers";
import { REC_PERFORMANCE_RESULTS_PAGE_SIZE } from "@/solar-rec-dashboard/lib/constants";
import type {
  PerformanceSourceRow,
  RecPerformanceContractYearSummaryRow,
  RecPerformanceResultRow,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Types + props
// ---------------------------------------------------------------------------

type RecPerfSortKey =
  | "applicationId"
  | "unitId"
  | "systemName"
  | "scheduleYearNumber"
  | "rollingAverage"
  | "contractPrice"
  | "expectedRecs"
  | "surplusShortfall"
  | "allocatedRecs"
  | "drawdownPayment";

export interface RecPerformanceEvaluationTabProps {
  performanceSourceRows: PerformanceSourceRow[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RecPerformanceEvaluationTab(
  props: RecPerformanceEvaluationTabProps,
) {
  const { performanceSourceRows } = props;

  // ── User input state ─────────────────────────────────────────────
  const [performanceContractId, setPerformanceContractId] = useState("");
  const [performanceDeliveryYearKey, setPerformanceDeliveryYearKey] = useState("");
  const [performancePreviousSurplusInput, setPerformancePreviousSurplusInput] =
    useState("0");
  const [performancePreviousDrawdownInput, setPerformancePreviousDrawdownInput] =
    useState("0");

  // ── Filter/sort/page state ──────────────────────────────────────
  const [recPerformanceResultsPage, setRecPerformanceResultsPage] = useState(1);
  const [recPerfSortBy, setRecPerfSortBy] = useState<RecPerfSortKey>("applicationId");
  const [recPerfSortDir, setRecPerfSortDir] = useState<"asc" | "desc">("asc");
  const [recPerfSearch, setRecPerfSearch] = useState("");
  // Phase 18: defer the search string so filteredRecPerformanceRows
  // re-runs as a low-priority update, keeping keystrokes responsive
  // on large rec-performance tables.
  const deferredRecPerfSearch = useDeferredValue(recPerfSearch);
  const [recPerfStatusFilter, setRecPerfStatusFilter] = useState<
    "all" | "surplus" | "shortfall"
  >("all");

  const handleRecPerfSort = (col: RecPerfSortKey) => {
    if (recPerfSortBy === col) {
      setRecPerfSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setRecPerfSortBy(col);
      setRecPerfSortDir("desc");
    }
  };

  const recPerfSortIndicator = (col: RecPerfSortKey) =>
    recPerfSortBy === col ? (recPerfSortDir === "asc" ? " ▲" : " ▼") : "";

  // ── Contract + delivery year selectors ──────────────────────────
  const performanceContractOptions = useMemo(
    () =>
      Array.from(new Set(performanceSourceRows.map((row) => row.contractId))).sort(
        (a, b) =>
          a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
      ),
    [performanceSourceRows],
  );

  const effectivePerformanceContractId =
    performanceContractId === "__ALL__" ||
    performanceContractOptions.includes(performanceContractId)
      ? performanceContractId
      : (performanceContractOptions[0] ?? "");

  const performanceDeliveryYearOptions = useMemo(() => {
    const byKey = new Map<
      string,
      {
        key: string;
        label: string;
        startDate: Date | null;
        endDate: Date | null;
      }
    >();

    performanceSourceRows
      .filter(
        (row) =>
          effectivePerformanceContractId === "__ALL__" ||
          row.contractId === effectivePerformanceContractId,
      )
      .forEach((row) => {
        row.years.forEach((year) => {
          const existing = byKey.get(year.key);
          const label = buildRecReviewDeliveryYearLabel(
            year.startDate,
            year.endDate,
            year.startRaw,
            year.endRaw,
          );
          if (existing) return;
          byKey.set(year.key, {
            key: year.key,
            label,
            startDate: year.startDate,
            endDate: year.endDate,
          });
        });
      });

    return Array.from(byKey.values()).sort((a, b) => {
      const aTime = a.startDate?.getTime() ?? Number.POSITIVE_INFINITY;
      const bTime = b.startDate?.getTime() ?? Number.POSITIVE_INFINITY;
      return aTime - bTime;
    });
  }, [effectivePerformanceContractId, performanceSourceRows]);

  const defaultPerformanceDeliveryYearKey = useMemo(() => {
    if (performanceDeliveryYearOptions.length === 0) return "";
    const now = new Date();
    const nowMs = now.getTime();

    // Prefer the currently-active schedule year window for this contract.
    const activeOption = performanceDeliveryYearOptions.find((option) => {
      if (!option.startDate || !option.endDate) return false;
      return nowMs >= option.startDate.getTime() && nowMs <= option.endDate.getTime();
    });
    if (activeOption) return activeOption.key;

    // Fallback to the most recent year that has already started.
    const startedOptions = performanceDeliveryYearOptions.filter(
      (option) => option.startDate && option.startDate.getTime() <= nowMs,
    );
    if (startedOptions.length > 0) {
      return startedOptions[startedOptions.length - 1]!.key;
    }

    // Final fallback: earliest available year.
    return performanceDeliveryYearOptions[0]!.key;
  }, [performanceDeliveryYearOptions]);

  const effectivePerformanceDeliveryYearKey =
    performanceDeliveryYearOptions.some(
      (option) => option.key === performanceDeliveryYearKey,
    )
      ? performanceDeliveryYearKey
      : defaultPerformanceDeliveryYearKey;

  const performanceSelectedDeliveryYearLabel =
    performanceDeliveryYearOptions.find(
      (option) => option.key === effectivePerformanceDeliveryYearKey,
    )?.label ?? "N/A";

  const performancePreviousSurplus =
    parseNumber(performancePreviousSurplusInput) ?? 0;
  const performancePreviousDrawdown =
    parseNumber(performancePreviousDrawdownInput) ?? 0;

  // ── The main evaluation memo ─────────────────────────────────────
  const recPerformanceEvaluation = useMemo(() => {
    const baseRows: RecPerformanceResultRow[] = performanceSourceRows
      .filter(
        (row) =>
          effectivePerformanceContractId === "__ALL__" ||
          row.contractId === effectivePerformanceContractId,
      )
      .map((row) => {
        const targetYearIndex = row.years.findIndex(
          (year) => year.key === effectivePerformanceDeliveryYearKey,
        );
        if (targetYearIndex === -1) return null;

        const recWindow = deriveRecPerformanceThreeYearValues(row, targetYearIndex);
        if (!recWindow) return null;

        const surplusShortfall = recWindow.rollingAverage - recWindow.expectedRecs;

        return {
          key: row.key,
          applicationId: row.systemId ?? "N/A",
          unitId: row.trackingSystemRefId,
          batchId: row.batchId ?? "N/A",
          systemName: row.systemName,
          contractId: row.contractId,
          scheduleYearNumber: recWindow.scheduleYearNumber,
          deliveryYearOne: recWindow.deliveryYearOne,
          deliveryYearTwo: recWindow.deliveryYearTwo,
          deliveryYearThree: recWindow.deliveryYearThree,
          deliveryYearOneSource: recWindow.deliveryYearOneSource,
          deliveryYearTwoSource: recWindow.deliveryYearTwoSource,
          deliveryYearThreeSource: recWindow.deliveryYearThreeSource,
          rollingAverage: recWindow.rollingAverage,
          contractPrice: row.recPrice,
          expectedRecs: recWindow.expectedRecs,
          surplusShortfall,
          allocatedRecs: 0,
          drawdownPayment: 0,
        } satisfies RecPerformanceResultRow;
      })
      .filter((row): row is RecPerformanceResultRow => row !== null)
      .sort((a, b) =>
        a.applicationId.localeCompare(b.applicationId, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );

    const surplusBeforeAllocation = baseRows.reduce(
      (sum, row) => sum + Math.max(0, row.surplusShortfall),
      0,
    );
    let remainingPool = performancePreviousSurplus + surplusBeforeAllocation;

    const deficitIndexes = baseRows
      .map((row, index) => ({ row, index }))
      .filter((entry) => entry.row.surplusShortfall < 0)
      .sort((a, b) => {
        const aPrice = a.row.contractPrice ?? Number.POSITIVE_INFINITY;
        const bPrice = b.row.contractPrice ?? Number.POSITIVE_INFINITY;
        if (aPrice !== bPrice) return aPrice - bPrice;
        return a.row.applicationId.localeCompare(b.row.applicationId, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });

    deficitIndexes.forEach(({ index }) => {
      const row = baseRows[index]!;
      const shortfall = Math.abs(row.surplusShortfall);
      const allocated = Math.min(shortfall, remainingPool);
      remainingPool -= allocated;
      const remainingShortfall = shortfall - allocated;
      const drawdown = -remainingShortfall * (row.contractPrice ?? 0);

      baseRows[index] = {
        ...row,
        allocatedRecs: allocated,
        drawdownPayment: Number(drawdown.toFixed(2)),
      };
    });

    const totalAllocatedRecs = baseRows.reduce(
      (sum, row) => sum + row.allocatedRecs,
      0,
    );
    const drawdownThisReport = baseRows.reduce(
      (sum, row) => sum + Math.abs(Math.min(row.drawdownPayment, 0)),
      0,
    );
    const unallocatedShortfallRecs = baseRows.reduce(
      (sum, row) =>
        sum +
        Math.max(0, Math.abs(Math.min(0, row.surplusShortfall)) - row.allocatedRecs),
      0,
    );

    return {
      rows: baseRows,
      systemCount: baseRows.length,
      surplusSystemCount: baseRows.filter((row) => row.surplusShortfall > 0).length,
      shortfallSystemCount: baseRows.filter((row) => row.surplusShortfall < 0).length,
      surplusBeforeAllocation,
      totalAllocatedRecs,
      netSurplusAfterAllocation:
        performancePreviousSurplus + surplusBeforeAllocation - totalAllocatedRecs,
      unallocatedShortfallRecs,
      drawdownThisReport,
      drawdownCumulative: drawdownThisReport + performancePreviousDrawdown,
    };
  }, [
    effectivePerformanceContractId,
    effectivePerformanceDeliveryYearKey,
    performancePreviousDrawdown,
    performancePreviousSurplus,
    performanceSourceRows,
  ]);

  // ── Contract-level summary ───────────────────────────────────────
  const recPerformanceContractYearSummaryRows =
    useMemo<RecPerformanceContractYearSummaryRow[]>(() => {
      if (!effectivePerformanceDeliveryYearKey) {
        return [];
      }

      type Builder = {
        contractId: string;
        systemsInThreeYearReview: number;
        totalRecDeliveryObligation: number;
        totalDeliveriesFromThreeYearReview: number;
        recDelta: number;
        totalDrawdownAmount: number;
      };

      const summaryByContract = new Map<string, Builder>();

      const getOrCreate = (contractId: string): Builder => {
        const existing = summaryByContract.get(contractId);
        if (existing) return existing;
        const next: Builder = {
          contractId,
          systemsInThreeYearReview: 0,
          totalRecDeliveryObligation: 0,
          totalDeliveriesFromThreeYearReview: 0,
          recDelta: 0,
          totalDrawdownAmount: 0,
        };
        summaryByContract.set(contractId, next);
        return next;
      };

      performanceContractOptions.forEach((contractId) => {
        getOrCreate(contractId);
      });
      getOrCreate("846");
      getOrCreate("918");
      getOrCreate("Unassigned");

      performanceSourceRows.forEach((row) => {
        const contractId = clean(row.contractId) || "Unassigned";
        const targetYearIndex = row.years.findIndex(
          (year) => year.key === effectivePerformanceDeliveryYearKey,
        );
        const recWindow = deriveRecPerformanceThreeYearValues(row, targetYearIndex);
        if (!recWindow) return;

        const recDelta = recWindow.rollingAverage - recWindow.expectedRecs;
        const shortfall = Math.max(
          0,
          recWindow.expectedRecs - recWindow.rollingAverage,
        );
        const drawdownAmount = shortfall * (row.recPrice ?? 0);

        const summary = getOrCreate(contractId);
        summary.systemsInThreeYearReview += 1;
        summary.totalRecDeliveryObligation += recWindow.expectedRecs;
        summary.totalDeliveriesFromThreeYearReview += recWindow.rollingAverage;
        summary.recDelta += recDelta;
        summary.totalDrawdownAmount += drawdownAmount;
      });

      return Array.from(summaryByContract.values())
        .map((row) => ({
          ...row,
          totalDrawdownAmount: Number(row.totalDrawdownAmount.toFixed(2)),
        }))
        .sort((a, b) =>
          a.contractId.localeCompare(b.contractId, undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        );
    }, [
      effectivePerformanceDeliveryYearKey,
      performanceContractOptions,
      performanceSourceRows,
    ]);

  const recPerformanceContractYearSummaryTotals = useMemo(() => {
    return recPerformanceContractYearSummaryRows.reduce(
      (acc, row) => {
        if (row.systemsInThreeYearReview <= 0) return acc;
        acc.contractsDueThisYear += 1;
        acc.totalSystemsInThreeYearReview += row.systemsInThreeYearReview;
        acc.totalRecDeliveryObligation += row.totalRecDeliveryObligation;
        acc.totalDeliveriesFromThreeYearReview += row.totalDeliveriesFromThreeYearReview;
        acc.recDelta += row.recDelta;
        acc.totalDrawdownAmount += row.totalDrawdownAmount;
        return acc;
      },
      {
        contractsDueThisYear: 0,
        totalSystemsInThreeYearReview: 0,
        totalRecDeliveryObligation: 0,
        totalDeliveriesFromThreeYearReview: 0,
        recDelta: 0,
        totalDrawdownAmount: 0,
      },
    );
  }, [recPerformanceContractYearSummaryRows]);

  // ── Filter + sort + pagination ───────────────────────────────────
  const filteredRecPerformanceRows = useMemo(() => {
    let rows = recPerformanceEvaluation.rows;
    if (deferredRecPerfSearch) {
      const q = deferredRecPerfSearch.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.applicationId.toLowerCase().includes(q) ||
          r.unitId.toLowerCase().includes(q) ||
          r.systemName.toLowerCase().includes(q),
      );
    }
    if (recPerfStatusFilter === "surplus")
      rows = rows.filter((r) => r.surplusShortfall > 0);
    else if (recPerfStatusFilter === "shortfall")
      rows = rows.filter((r) => r.surplusShortfall < 0);
    const dir = recPerfSortDir === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const key = recPerfSortBy;
      if (key === "applicationId" || key === "unitId" || key === "systemName") {
        return (
          a[key].localeCompare(b[key], undefined, {
            numeric: true,
            sensitivity: "base",
          }) * dir
        );
      }
      const aVal = key === "contractPrice" ? (a[key] ?? Infinity) : a[key];
      const bVal = key === "contractPrice" ? (b[key] ?? Infinity) : b[key];
      return ((aVal as number) - (bVal as number)) * dir;
    });
    return rows;
  }, [
    recPerformanceEvaluation.rows,
    deferredRecPerfSearch,
    recPerfStatusFilter,
    recPerfSortBy,
    recPerfSortDir,
  ]);

  const recPerformanceResultsTotalPages = Math.max(
    1,
    Math.ceil(filteredRecPerformanceRows.length / REC_PERFORMANCE_RESULTS_PAGE_SIZE),
  );
  const recPerformanceResultsCurrentPage = Math.min(
    recPerformanceResultsPage,
    recPerformanceResultsTotalPages,
  );
  const recPerformanceResultsPageStartIndex =
    (recPerformanceResultsCurrentPage - 1) * REC_PERFORMANCE_RESULTS_PAGE_SIZE;
  const recPerformanceResultsPageEndIndex =
    recPerformanceResultsPageStartIndex + REC_PERFORMANCE_RESULTS_PAGE_SIZE;
  const visibleRecPerformanceRows = useMemo(
    () =>
      filteredRecPerformanceRows.slice(
        recPerformanceResultsPageStartIndex,
        recPerformanceResultsPageEndIndex,
      ),
    [
      filteredRecPerformanceRows,
      recPerformanceResultsPageEndIndex,
      recPerformanceResultsPageStartIndex,
    ],
  );

  useEffect(() => {
    if (recPerformanceResultsPage <= recPerformanceResultsTotalPages) return;
    setRecPerformanceResultsPage(recPerformanceResultsTotalPages);
  }, [recPerformanceResultsPage, recPerformanceResultsTotalPages]);

  useEffect(() => {
    setRecPerformanceResultsPage(1);
  }, [
    effectivePerformanceContractId,
    effectivePerformanceDeliveryYearKey,
    recPerfSearch,
    recPerfStatusFilter,
    recPerfSortBy,
    recPerfSortDir,
  ]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            3-Year Rolling Average Annual Report Logic
          </CardTitle>
          <CardDescription>
            Mirrors the REC Performance Evaluation model: rolling average by
            system, expected delivery, surplus allocation, and drawdown
            payments.
            <span className="ml-2 inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
              Deliveries from Transfer History
            </span>
          </CardDescription>
        </CardHeader>
      </Card>

      {performanceContractOptions.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No Performance Data Available</CardTitle>
            <CardDescription>
              Upload ABP Report and Solar Applications, then scrape Schedule B
              PDFs in the Delivery Tracker tab to populate obligations, to
              calculate performance evaluation metrics.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Evaluation Controls</CardTitle>
              <CardDescription>
                Select the contract and delivery year, then set prior
                carry-forward values if needed.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">
                  Contract ID
                </label>
                <select
                  className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                  value={effectivePerformanceContractId}
                  onChange={(event) => setPerformanceContractId(event.target.value)}
                >
                  <option value="__ALL__">All Contracts</option>
                  {performanceContractOptions.map((contractId) => (
                    <option key={contractId} value={contractId}>
                      {contractId}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">
                  Delivery Year
                </label>
                <select
                  className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                  value={effectivePerformanceDeliveryYearKey}
                  onChange={(event) =>
                    setPerformanceDeliveryYearKey(event.target.value)
                  }
                >
                  {performanceDeliveryYearOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">
                  Previous DY Aggregate Surplus RECs (after allocation)
                </label>
                <Input
                  type="number"
                  step="1"
                  value={performancePreviousSurplusInput}
                  onChange={(event) =>
                    setPerformancePreviousSurplusInput(event.target.value)
                  }
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">
                  Previous DY Aggregate Drawdown Payments (&lt;$5,000)
                </label>
                <Input
                  type="number"
                  step="0.01"
                  value={performancePreviousDrawdownInput}
                  onChange={(event) =>
                    setPerformancePreviousDrawdownInput(event.target.value)
                  }
                />
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardHeader>
                <CardDescription>Contract ID</CardDescription>
                <CardTitle className="text-2xl">
                  {effectivePerformanceContractId === "__ALL__"
                    ? "All Contracts"
                    : effectivePerformanceContractId || "N/A"}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Delivery Year</CardDescription>
                <CardTitle className="text-2xl">
                  {performanceSelectedDeliveryYearLabel}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Systems in Evaluation</CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(recPerformanceEvaluation.systemCount)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Shortfall Systems</CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(recPerformanceEvaluation.shortfallSystemCount)}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Card>
              <CardHeader>
                <CardDescription>
                  Surplus RECs (before allocation, this report)
                </CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(recPerformanceEvaluation.surplusBeforeAllocation)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>
                  RECs Allocated (lowest price first)
                </CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(recPerformanceEvaluation.totalAllocatedRecs)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Net Surplus RECs After Allocation</CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(recPerformanceEvaluation.netSurplusAfterAllocation)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Unallocated Shortfall RECs</CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(recPerformanceEvaluation.unallocatedShortfallRecs)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Drawdown Payments (this report)</CardDescription>
                <CardTitle className="text-2xl">
                  {formatCurrency(recPerformanceEvaluation.drawdownThisReport)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Drawdown Payments (cumulative)</CardDescription>
                <CardTitle className="text-2xl">
                  {formatCurrency(recPerformanceEvaluation.drawdownCumulative)}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Current Year 3-Year Rolling Summary by Contract
              </CardTitle>
              <CardDescription>
                Delivery Year {performanceSelectedDeliveryYearLabel}. Includes
                only systems currently in 3-year rolling review for that year.
                Contracts 846, 918, and Unassigned are shown even when
                obligation is 0.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Card>
                  <CardHeader>
                    <CardDescription>Contracts Due This Year</CardDescription>
                    <CardTitle className="text-2xl">
                      {formatNumber(
                        recPerformanceContractYearSummaryTotals.contractsDueThisYear,
                      )}
                    </CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <CardDescription>
                      Systems in 3-Year Review (Current Year)
                    </CardDescription>
                    <CardTitle className="text-2xl">
                      {formatNumber(
                        recPerformanceContractYearSummaryTotals.totalSystemsInThreeYearReview,
                      )}
                    </CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <CardDescription>
                      Total REC Delivery Obligation (3-Year Rolling)
                    </CardDescription>
                    <CardTitle className="text-2xl">
                      {formatNumber(
                        recPerformanceContractYearSummaryTotals.totalRecDeliveryObligation,
                      )}
                    </CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <CardDescription>
                      Total Deliveries (3-Year Rolling Review Systems)
                    </CardDescription>
                    <CardTitle className="text-2xl">
                      {formatNumber(
                        recPerformanceContractYearSummaryTotals.totalDeliveriesFromThreeYearReview,
                      )}
                    </CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <CardDescription>Delta RECs (Delivered - Obligation)</CardDescription>
                    <CardTitle
                      className={`text-2xl ${
                        recPerformanceContractYearSummaryTotals.recDelta < 0
                          ? "text-rose-700"
                          : recPerformanceContractYearSummaryTotals.recDelta > 0
                            ? "text-emerald-700"
                            : ""
                      }`}
                    >
                      {formatSignedNumber(
                        recPerformanceContractYearSummaryTotals.recDelta,
                      )}
                    </CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <CardDescription>Total Drawdown Amount</CardDescription>
                    <CardTitle className="text-2xl">
                      {formatCurrency(
                        recPerformanceContractYearSummaryTotals.totalDrawdownAmount,
                      )}
                    </CardTitle>
                  </CardHeader>
                </Card>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contract ID</TableHead>
                    <TableHead>Systems in 3-Year Review</TableHead>
                    <TableHead>3-Year Rolling Obligation (RECs)</TableHead>
                    <TableHead>Total Deliveries (3-Year Rolling)</TableHead>
                    <TableHead>Delta RECs</TableHead>
                    <TableHead>Total Drawdown Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recPerformanceContractYearSummaryRows.map((row) => (
                    <TableRow key={`rec-performance-contract-summary-${row.contractId}`}>
                      <TableCell className="font-medium">{row.contractId}</TableCell>
                      <TableCell>
                        {formatNumber(row.systemsInThreeYearReview)}
                      </TableCell>
                      <TableCell>
                        {formatNumber(row.totalRecDeliveryObligation)}
                      </TableCell>
                      <TableCell>
                        {formatNumber(row.totalDeliveriesFromThreeYearReview)}
                      </TableCell>
                      <TableCell
                        className={
                          row.recDelta < 0
                            ? "text-rose-700 font-semibold"
                            : row.recDelta > 0
                              ? "text-emerald-700 font-semibold"
                              : ""
                        }
                      >
                        {formatSignedNumber(row.recDelta)}
                      </TableCell>
                      <TableCell>{formatCurrency(row.totalDrawdownAmount)}</TableCell>
                    </TableRow>
                  ))}
                  {recPerformanceContractYearSummaryRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-6 text-center text-slate-500">
                        No contract-level REC performance rows available for this
                        delivery year.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between">
              <div>
                <CardTitle className="text-base">Results by System</CardTitle>
                <CardDescription>
                  Columns follow the REC Performance Evaluation workbook
                  structure.
                </CardDescription>
              </div>
              {filteredRecPerformanceRows.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const csv = buildCsv(
                      [
                        "application_id",
                        "unit_id",
                        "system_name",
                        "contract_id",
                        "schedule_year",
                        "dy1_recs",
                        "dy1_source",
                        "dy2_recs",
                        "dy2_source",
                        "dy3_recs",
                        "dy3_source",
                        "three_year_avg_floor",
                        "contract_price",
                        "expected_recs",
                        "surplus_shortfall",
                        "recs_allocated",
                        "drawdown_payment",
                      ],
                      filteredRecPerformanceRows.map((r) => ({
                        application_id: r.applicationId,
                        unit_id: r.unitId,
                        system_name: r.systemName,
                        contract_id: r.contractId,
                        schedule_year: r.scheduleYearNumber,
                        dy1_recs: r.deliveryYearOne,
                        dy1_source: r.deliveryYearOneSource,
                        dy2_recs: r.deliveryYearTwo,
                        dy2_source: r.deliveryYearTwoSource,
                        dy3_recs: r.deliveryYearThree,
                        dy3_source: r.deliveryYearThreeSource,
                        three_year_avg_floor: r.rollingAverage,
                        contract_price: r.contractPrice,
                        expected_recs: r.expectedRecs,
                        surplus_shortfall: r.surplusShortfall,
                        recs_allocated: r.allocatedRecs,
                        drawdown_payment: r.drawdownPayment,
                      })),
                    );
                    const contractSlug =
                      effectivePerformanceContractId === "__ALL__"
                        ? "all-contracts"
                        : `contract-${effectivePerformanceContractId}`;
                    triggerCsvDownload(
                      `rec-performance-eval-${contractSlug}-dy${performanceSelectedDeliveryYearLabel}-${timestampForCsvFileName()}.csv`,
                      csv,
                    );
                  }}
                >
                  Export CSV
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  className="h-8 rounded-md border border-slate-300 bg-white px-2.5 text-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  style={{ width: 280 }}
                  placeholder="Search system, application ID, unit ID…"
                  value={recPerfSearch}
                  onChange={(e) => setRecPerfSearch(e.target.value)}
                />
                <select
                  className="h-8 rounded-md border border-slate-300 bg-white px-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={recPerfStatusFilter}
                  onChange={(e) =>
                    setRecPerfStatusFilter(
                      e.target.value as "all" | "surplus" | "shortfall",
                    )
                  }
                >
                  <option value="all">All statuses</option>
                  <option value="surplus">Surplus only</option>
                  <option value="shortfall">Shortfall only</option>
                </select>
              </div>
              <div className="flex items-center justify-between text-xs text-slate-600">
                <span>
                  Showing {formatNumber(visibleRecPerformanceRows.length)} of{" "}
                  {formatNumber(filteredRecPerformanceRows.length)} rows
                  {filteredRecPerformanceRows.length !==
                    recPerformanceEvaluation.rows.length && (
                    <>
                      {" "}
                      ({formatNumber(recPerformanceEvaluation.rows.length)} total)
                    </>
                  )}
                </span>
                <span>
                  Page {formatNumber(recPerformanceResultsCurrentPage)} of{" "}
                  {formatNumber(recPerformanceResultsTotalPages)}
                </span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50"
                      onClick={() => handleRecPerfSort("applicationId")}
                    >
                      Application ID{recPerfSortIndicator("applicationId")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50"
                      onClick={() => handleRecPerfSort("unitId")}
                    >
                      Unit ID{recPerfSortIndicator("unitId")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50"
                      onClick={() => handleRecPerfSort("systemName")}
                    >
                      System{recPerfSortIndicator("systemName")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50"
                      onClick={() => handleRecPerfSort("scheduleYearNumber")}
                    >
                      Yr{recPerfSortIndicator("scheduleYearNumber")}
                    </TableHead>
                    <TableHead>DY 1 (RECs)</TableHead>
                    <TableHead>DY 2 (RECs)</TableHead>
                    <TableHead>DY 3 (RECs)</TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50"
                      onClick={() => handleRecPerfSort("rollingAverage")}
                    >
                      3-Year Avg (Floor){recPerfSortIndicator("rollingAverage")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50"
                      onClick={() => handleRecPerfSort("contractPrice")}
                    >
                      Contract Price ($/REC){recPerfSortIndicator("contractPrice")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50"
                      onClick={() => handleRecPerfSort("expectedRecs")}
                    >
                      Expected RECs{recPerfSortIndicator("expectedRecs")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50"
                      onClick={() => handleRecPerfSort("surplusShortfall")}
                    >
                      Surplus / (Shortfall){recPerfSortIndicator("surplusShortfall")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50"
                      onClick={() => handleRecPerfSort("allocatedRecs")}
                    >
                      RECs Allocated{recPerfSortIndicator("allocatedRecs")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50"
                      onClick={() => handleRecPerfSort("drawdownPayment")}
                    >
                      Drawdown Payment{recPerfSortIndicator("drawdownPayment")}
                    </TableHead>
                    <TableHead>DY 1 Source</TableHead>
                    <TableHead>DY 2 Source</TableHead>
                    <TableHead>DY 3 Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRecPerformanceRows.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell>{row.applicationId}</TableCell>
                      <TableCell>{row.unitId}</TableCell>
                      <TableCell className="font-medium">{row.systemName}</TableCell>
                      <TableCell className="text-center text-xs text-slate-500">
                        {row.scheduleYearNumber}
                      </TableCell>
                      <TableCell>{formatNumber(row.deliveryYearOne)}</TableCell>
                      <TableCell>{formatNumber(row.deliveryYearTwo)}</TableCell>
                      <TableCell>{formatNumber(row.deliveryYearThree)}</TableCell>
                      <TableCell>{formatNumber(row.rollingAverage)}</TableCell>
                      <TableCell>{formatCurrency(row.contractPrice)}</TableCell>
                      <TableCell>{formatNumber(row.expectedRecs)}</TableCell>
                      <TableCell
                        className={
                          row.surplusShortfall < 0
                            ? "text-rose-700 font-semibold"
                            : row.surplusShortfall > 0
                              ? "text-emerald-700 font-semibold"
                              : ""
                        }
                      >
                        {formatSignedNumber(row.surplusShortfall)}
                      </TableCell>
                      <TableCell>{formatNumber(row.allocatedRecs)}</TableCell>
                      <TableCell
                        className={
                          row.drawdownPayment < 0 ? "text-rose-700 font-semibold" : ""
                        }
                      >
                        {formatCurrency(row.drawdownPayment)}
                      </TableCell>
                      <TableCell>{row.deliveryYearOneSource}</TableCell>
                      <TableCell>{row.deliveryYearTwoSource}</TableCell>
                      <TableCell>{row.deliveryYearThreeSource}</TableCell>
                    </TableRow>
                  ))}
                  {visibleRecPerformanceRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={16} className="py-6 text-center text-slate-500">
                        No REC performance rows available.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setRecPerformanceResultsPage((page) => Math.max(1, page - 1))
                  }
                  disabled={recPerformanceResultsCurrentPage <= 1}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setRecPerformanceResultsPage((page) =>
                      Math.min(recPerformanceResultsTotalPages, page + 1),
                    )
                  }
                  disabled={
                    recPerformanceResultsCurrentPage >= recPerformanceResultsTotalPages
                  }
                >
                  Next
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
