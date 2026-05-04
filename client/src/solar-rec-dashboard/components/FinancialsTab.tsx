/**
 * Financials tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 5 of the
 * god-component decomposition. Owns:
 *   - 9 useStates (4 filter/sort, editing row, rescan batch tracking,
 *     rescan statuses map, local optimistic overrides cache... wait)
 *     Actually: 4 filter/sort, editingRow, rescanStatuses,
 *     batchRescanRunning — that's 6 useState + 1 useRef owned here.
 *   - 4 useMemos (part2VerifiedSystems, financialRevenueAtRisk,
 *     financialProfitDebug, filteredFinancialRows, financialFlaggedCount)
 *   - 2 tRPC mutations (updateContractOverride, rescanSingleContract)
 *   - batch rescan loop + edit override dialog
 *
 * The parent still owns:
 *   - `financialProfitData` — shared with Overview tab summary tiles
 *   - `contractScanResultsQuery` — shared with Overview + Pipeline
 *   - `financialCsgIds` — feeds the shared query
 *   - `localOverrides` — shared with Pipeline (cash flow aggregator
 *     reads them too)
 *
 * Those come in via props. The component mounts only when
 * `activeTab === "financials"` so none of the filter/sort/memo work
 * runs on other tabs.
 */

import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { AskAiPanel } from "@/components/AskAiPanel";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Bar,
  BarChart,
  CartesianGrid,
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
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
// Task 5.7 PR-B (2026-04-26): updateContractOverride +
// rescanSingleContract migrated from main `abpSettlement` to
// standalone Solar REC `contractScan`. Aliased so the existing call
// shape stays unchanged after the abpSettlement → contractScan
// rename below.
import { solarRecTrpc as trpc } from "@/solar-rec/solarRecTrpc";
import {
  buildCsv,
  timestampForCsvFileName,
  triggerCsvDownload,
} from "@/solar-rec-dashboard/lib/csvIo";
import {
  formatNumber,
  parseNumber,
  toPercentValue,
} from "@/solar-rec-dashboard/lib/helpers";
import type {
  ContractScanResultRow,
  FinancialProfitData,
  ProfitRow,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";

// Mirrors `FinancialsDebugAggregate` returned by
// `getDashboardFinancials` (Phase 5e step 4 PR-B). The shape is small
// enough to keep in lock-step inline rather than cross-importing from
// `server/services/solar/buildFinancialsAggregates.ts`.
const FINANCIALS_DEBUG_EMPTY: FinancialsDebugData = {
  counts: {
    part2VerifiedAbpRows: 0,
    mappingRows: 0,
    iccReport3Rows: 0,
    financialCsgIdsCount: 0,
    scanResultsReturned: 0,
  },
  chain: {
    iterated: 0,
    withAppId: 0,
    withCsgId: 0,
    withScan: 0,
    withIcc: 0,
    final: 0,
  },
  samples: {
    mappingCsgIds: [],
    scanCsgIds: [],
    mappingAppIds: [],
    iccAppIds: [],
    part2AppIds: [],
  },
  icc: {
    headers: [],
    appIdFieldFound: [],
    contractValueFieldFound: [],
  },
};

export type FinancialsDebugData = {
  counts: {
    part2VerifiedAbpRows: number;
    mappingRows: number;
    iccReport3Rows: number;
    financialCsgIdsCount: number;
    scanResultsReturned: number;
  };
  chain: {
    iterated: number;
    withAppId: number;
    withCsgId: number;
    withScan: number;
    withIcc: number;
    final: number;
  };
  samples: {
    mappingCsgIds: string[];
    scanCsgIds: string[];
    mappingAppIds: string[];
    iccAppIds: string[];
    part2AppIds: string[];
  };
  icc: {
    headers: string[];
    appIdFieldFound: string[];
    contractValueFieldFound: string[];
  };
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FinancialsTabProps {
  // Master system list (parent-owned)
  systems: SystemRecord[];

  // Financials profit/collateralization data. Computed by the parent's
  // `financialProfitData` useMemo, which is gated on `isFinancialsTabActive
  // || isOverviewTabActive` and shared with Overview summary tiles.
  financialProfitData: FinancialProfitData;

  // Contract scan query state. The query itself stays in the parent
  // because it's also gated on Pipeline + Overview, and those tabs
  // also read from the result.
  contractScanResults: ContractScanResultRow[];
  contractScanStatus: "pending" | "error" | "success";
  contractScanIsFetching: boolean;
  contractScanError: unknown;
  contractScanRefetch: () => Promise<unknown>;
  financialsRefetch: () => Promise<unknown>;
  /**
   * PR #334 follow-up item 2 (2026-05-02) — invalidate the slim
   * Overview KPI summary query when override / rescan flows
   * mutate scan rows. Without this the slim query can serve a
   * cached "available: false" (or pre-edit KPI values) on the
   * next Overview mount until React Query's `staleTime` expires.
   * Server-side cache freshness is item 1; this is the
   * defense-in-depth on the client cache.
   */
  invalidateFinancialKpiSummary: () => Promise<unknown>;

  // CSG IDs feeding the contract scan query (debug panel reports the
  // length so the user can see where data is dropping).
  financialCsgIds: string[];

  // Phase 5e step 4 PR-B (2026-04-30) — server-driven static debug
  // shape from `getDashboardFinancials.debug`. Replaces the prior
  // client memo that walked `datasets.abpCsgSystemMapping.rows` +
  // `datasets.abpIccReport3Rows.rows`. Null while the query is
  // loading. The dynamic React-Query state fields
  // (queryStatus/queryFetching/etc.) are composed in by the tab.
  financialsDebug: FinancialsDebugData | null;

  // Local optimistic overrides. State lives in the parent because
  // the Pipeline tab's cash flow aggregator also reads it.
  localOverrides: Map<string, { vfp: number; acp: number }>;
  setLocalOverrides: React.Dispatch<
    React.SetStateAction<Map<string, { vfp: number; acp: number }>>
  >;

  // Callback for clicking a system name (opens the parent's system
  // detail sheet).
  onSelectSystem: (systemKey: string) => void;
}

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type FinancialSortKey =
  | "systemName"
  | "grossContractValue"
  | "vendorFeePercent"
  | "vendorFeeAmount"
  | "utilityCollateral"
  | "additionalCollateralPercent"
  | "additionalCollateralAmount"
  | "ccAuth5Percent"
  | "applicationFee"
  | "totalDeductions"
  | "profit"
  | "totalCollateralization";

type RescanStatus = {
  status: "queued" | "active" | "completed" | "error";
  changes?: string;
  error?: string;
};

type EditingFinancialRow = {
  csgId: string;
  systemName: string;
  vendorFeePercent: string;
  additionalCollateralPercent: string;
  notes: string;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function FinancialsTab(props: FinancialsTabProps) {
  const {
    systems,
    financialProfitData,
    contractScanResults,
    contractScanStatus,
    contractScanIsFetching,
    contractScanError,
    contractScanRefetch,
    financialsRefetch,
    invalidateFinancialKpiSummary,
    financialCsgIds,
    financialsDebug,
    localOverrides,
    setLocalOverrides,
    onSelectSystem,
  } = props;

  // --- Filter + sort state ---
  const [financialSortBy, setFinancialSortBy] = useState<FinancialSortKey>("profit");
  const [financialSortDir, setFinancialSortDir] = useState<"asc" | "desc">("desc");
  const [financialSearch, setFinancialSearch] = useState("");
  // Phase 18: defer the search string so filteredFinancialRows
  // re-runs as a low-priority update, keeping keystrokes responsive
  // on large profit tables.
  const deferredFinancialSearch = useDeferredValue(financialSearch);
  const [financialFilter, setFinancialFilter] = useState<"all" | "needs-review" | "ok">(
    "all",
  );

  // --- Edit override dialog state ---
  const [editingFinancialRow, setEditingFinancialRow] =
    useState<EditingFinancialRow | null>(null);

  // --- Batch rescan state ---
  const [rescanStatuses, setRescanStatuses] = useState<Map<string, RescanStatus>>(
    new Map(),
  );
  const [batchRescanRunning, setBatchRescanRunning] = useState(false);
  const batchRescanCancelledRef = useRef(false);

  // --- tRPC mutations (owned by this component) ---
  const updateContractOverride = trpc.contractScan.updateContractOverride.useMutation();
  const rescanSingleContract = trpc.contractScan.rescanSingleContract.useMutation();

  // -------------------------------------------------------------------------
  // Derived: part-2-verified systems (drives revenue at risk)
  // -------------------------------------------------------------------------
  const part2VerifiedSystems = useMemo(
    () => systems.filter((sys) => sys.part2VerificationDate !== null),
    [systems],
  );

  // -------------------------------------------------------------------------
  // Revenue at risk = offline or terminated systems with contracted value
  // -------------------------------------------------------------------------
  const financialRevenueAtRisk = useMemo(() => {
    const now = new Date();
    const atRiskSystems: {
      name: string;
      riskType: string;
      value: number;
      lastDate: string;
      daysOffline: number;
    }[] = [];

    part2VerifiedSystems.forEach((sys) => {
      if ((sys.contractedValue ?? 0) <= 0) return;
      let riskType = "";
      if (!sys.isReporting) riskType = "Offline";
      else if (sys.isTerminated) riskType = "Terminated";
      if (!riskType) return;

      const daysOffline = sys.latestReportingDate
        ? Math.floor(
            (now.getTime() - sys.latestReportingDate.getTime()) /
              (1000 * 60 * 60 * 24),
          )
        : 999;
      atRiskSystems.push({
        name: sys.systemName,
        riskType,
        value: sys.contractedValue ?? 0,
        lastDate: sys.latestReportingDate?.toLocaleDateString() ?? "Never",
        daysOffline,
      });
    });

    const totalAtRisk = atRiskSystems.reduce((a, s) => a + s.value, 0);
    const totalPortfolio = part2VerifiedSystems.reduce(
      (a, s) => a + (s.contractedValue ?? 0),
      0,
    );

    const byType = new Map<string, { type: string; count: number; value: number }>();
    atRiskSystems.forEach((s) => {
      const g = byType.get(s.riskType) ?? { type: s.riskType, count: 0, value: 0 };
      g.count += 1;
      g.value += s.value;
      byType.set(s.riskType, g);
    });

    return {
      total: totalAtRisk,
      percent: toPercentValue(totalAtRisk, totalPortfolio),
      byType: Array.from(byType.values()),
      systems: atRiskSystems.sort((a, b) => b.value - a.value),
    };
  }, [part2VerifiedSystems]);

  // -------------------------------------------------------------------------
  // Debug panel: composes the server-derived static debug shape (from
  // `getDashboardFinancials.debug`) with the current local React-Query
  // state (status / isFetching / error). Phase 5e step 4 PR-B.
  // -------------------------------------------------------------------------
  const financialProfitDebug = useMemo(() => {
    const queryErrorMessage =
      contractScanError instanceof Error
        ? contractScanError.message
        : contractScanError
          ? String(contractScanError)
          : null;
    const staticDebug = financialsDebug ?? FINANCIALS_DEBUG_EMPTY;
    return {
      queryStatus: contractScanStatus,
      queryFetching: contractScanIsFetching,
      queryEnabled: financialCsgIds.length > 0,
      queryErrorMessage,
      counts: staticDebug.counts,
      chain: staticDebug.chain,
      samples: staticDebug.samples,
      icc: staticDebug.icc,
    };
  }, [
    financialsDebug,
    contractScanError,
    contractScanIsFetching,
    contractScanStatus,
    financialCsgIds.length,
  ]);

  // -------------------------------------------------------------------------
  // Filtered + sorted view of the profit rows
  // -------------------------------------------------------------------------
  const filteredFinancialRows = useMemo(() => {
    let rows: ProfitRow[] = financialProfitData.rows;

    if (financialFilter === "needs-review") {
      rows = rows.filter((r) => r.needsReview);
    } else if (financialFilter === "ok") {
      rows = rows.filter((r) => !r.needsReview);
    }

    const needle = deferredFinancialSearch.trim().toLowerCase();
    if (needle) {
      rows = rows.filter((r) =>
        [r.systemName, r.applicationId, r.csgId].join(" ").toLowerCase().includes(needle),
      );
    }

    const dir = financialSortDir === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const key = financialSortBy;
      if (key === "systemName") {
        return (
          a.systemName.localeCompare(b.systemName, undefined, {
            numeric: true,
            sensitivity: "base",
          }) * dir
        );
      }
      return ((a[key] as number) - (b[key] as number)) * dir;
    });

    return rows;
  }, [
    financialProfitData.rows,
    financialFilter,
    deferredFinancialSearch,
    financialSortBy,
    financialSortDir,
  ]);

  const financialFlaggedCount = useMemo(
    () => financialProfitData.rows.filter((r) => r.needsReview).length,
    [financialProfitData.rows],
  );

  // -------------------------------------------------------------------------
  // Header sort helpers
  // -------------------------------------------------------------------------
  const financialSortIndicator = (col: FinancialSortKey) =>
    financialSortBy === col ? (financialSortDir === "asc" ? " ▲" : " ▼") : "";

  const handleFinancialSort = useCallback(
    (col: FinancialSortKey) => {
      if (financialSortBy === col) {
        setFinancialSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setFinancialSortBy(col);
        setFinancialSortDir("desc");
      }
    },
    [financialSortBy],
  );

  // -------------------------------------------------------------------------
  // Batch rescan: walks the current filtered rows, rescans each,
  // updates per-row status, and refetches the parent query at the end.
  // -------------------------------------------------------------------------
  const handleBatchRescan = useCallback(async () => {
    const rowsToScan = filteredFinancialRows;
    if (rowsToScan.length === 0) return;

    batchRescanCancelledRef.current = false;
    setBatchRescanRunning(true);

    // PR #339 follow-up item 1 (2026-05-05) — wrap the entire
    // post-`setBatchRescanRunning(true)` body in try/finally so a
    // thrown refetch / invalidate doesn't strand the UI in
    // "running" mode. Pre-fix the final block ran outside any
    // catch boundary; a transient network error during refetch
    // left the Cancel button stuck visible.
    try {
    const initial = new Map<string, RescanStatus>();
    for (const row of rowsToScan) {
      initial.set(row.csgId, { status: "queued" });
    }
    setRescanStatuses(initial);

    for (const row of rowsToScan) {
      if (batchRescanCancelledRef.current) break;

      setRescanStatuses((prev) => {
        const next = new Map(prev);
        next.set(row.csgId, { status: "active" });
        return next;
      });

      try {
        const result = await rescanSingleContract.mutateAsync({ csgId: row.csgId });

        const changes: string[] = [];
        const oldVfp = row.vendorFeePercent;
        const newVfp = result.vendorFeePercent ?? 0;
        if (newVfp !== oldVfp) {
          changes.push(`Vendor Fee: ${oldVfp}% \u2192 ${newVfp}%`);
        }
        const oldAcp = row.additionalCollateralPercent;
        const newAcp = result.additionalCollateralPercent ?? 0;
        if (newAcp !== oldAcp) {
          changes.push(`Collateral: ${oldAcp}% \u2192 ${newAcp}%`);
        }

        setRescanStatuses((prev) => {
          const next = new Map(prev);
          next.set(row.csgId, {
            status: "completed",
            changes: changes.length > 0 ? changes.join("; ") : "No changes",
          });
          return next;
        });
      } catch (err) {
        setRescanStatuses((prev) => {
          const next = new Map(prev);
          next.set(row.csgId, {
            status: "error",
            error: err instanceof Error ? err.message : "Failed",
          });
          return next;
        });
      }
    }

      // PR #338 follow-up item 5 + PR #339 follow-up item 1
      // (2026-05-05) — parallel refetch of the two independent
      // heavy queries; the slim KPI invalidate must come AFTER
      // both because the heavy financials refetch is what writes
      // the side cache. A thrown refetch/invalidate is caught by
      // the outer try/finally so the Running flag still flips off.
      await Promise.all([contractScanRefetch(), financialsRefetch()]);
      await invalidateFinancialKpiSummary();
    } finally {
      setBatchRescanRunning(false);
    }
  }, [
    contractScanRefetch,
    filteredFinancialRows,
    financialsRefetch,
    invalidateFinancialKpiSummary,
    rescanSingleContract,
  ]);

  // -------------------------------------------------------------------------
  // Save edit-override dialog: call the mutation, optimistically update
  // the local overrides cache so the table reflects the change instantly
  // (the 28K-CSG-ID refetch takes 20s+), then clear the override once
  // the authoritative data catches up.
  // -------------------------------------------------------------------------
  const saveOverride = useCallback(async () => {
    if (!editingFinancialRow) return;
    try {
      await updateContractOverride.mutateAsync({
        csgId: editingFinancialRow.csgId,
        vendorFeePercent: editingFinancialRow.vendorFeePercent
          ? parseFloat(editingFinancialRow.vendorFeePercent)
          : null,
        additionalCollateralPercent: editingFinancialRow.additionalCollateralPercent
          ? parseFloat(editingFinancialRow.additionalCollateralPercent)
          : null,
        notes: editingFinancialRow.notes || null,
      });
      toast.success(`Override saved for CSG ${editingFinancialRow.csgId}`);
      const savedCsgId = editingFinancialRow.csgId;
      const newVfp = editingFinancialRow.vendorFeePercent
        ? parseFloat(editingFinancialRow.vendorFeePercent)
        : 0;
      const newAcp = editingFinancialRow.additionalCollateralPercent
        ? parseFloat(editingFinancialRow.additionalCollateralPercent)
        : 0;
      setLocalOverrides((prev) => {
        const next = new Map(prev);
        next.set(savedCsgId, { vfp: newVfp, acp: newAcp });
        return next;
      });
      setEditingFinancialRow(null);
      // Background refetch to sync authoritative DB data, then clear
      // local overrides (the DB data now includes them). Slim
      // Overview KPI query is invalidated alongside so the next
      // Overview mount picks up the freshly-recomputed KPIs from
      // the side cache.
      Promise.all([
        contractScanRefetch(),
        financialsRefetch(),
        invalidateFinancialKpiSummary(),
      ]).then(() => {
        setLocalOverrides((prev) => {
          const next = new Map(prev);
          next.delete(savedCsgId);
          return next;
        });
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save override");
    }
  }, [
    contractScanRefetch,
    editingFinancialRow,
    financialsRefetch,
    invalidateFinancialKpiSummary,
    setLocalOverrides,
    updateContractOverride,
  ]);

  // -------------------------------------------------------------------------
  // CSV downloads
  // -------------------------------------------------------------------------
  const downloadRevenueAtRiskCsv = useCallback(() => {
    const csv = buildCsv(
      ["system", "risk_type", "contract_value", "last_reporting", "days_offline"],
      financialRevenueAtRisk.systems.map((s) => ({
        system: s.name,
        risk_type: s.riskType,
        contract_value: s.value,
        last_reporting: s.lastDate,
        days_offline: s.daysOffline,
      })),
    );
    triggerCsvDownload(`revenue-at-risk-${timestampForCsvFileName()}.csv`, csv);
  }, [financialRevenueAtRisk.systems]);

  const downloadProfitTableCsv = useCallback(() => {
    const csv = buildCsv(
      [
        "system_name",
        "application_id",
        "csg_id",
        "gross_contract_value",
        "vendor_fee_percent",
        "vendor_fee_amount",
        "utility_5pct_collateral",
        "additional_collateral_percent",
        "additional_collateral_amount",
        "cc_auth_5pct",
        "application_fee",
        "total_deductions",
        "profit",
        "total_collateralization",
        "needs_review",
        "review_reason",
      ],
      financialProfitData.rows.map((r) => ({
        system_name: r.systemName,
        application_id: r.applicationId,
        csg_id: r.csgId,
        gross_contract_value: r.grossContractValue,
        vendor_fee_percent: r.vendorFeePercent,
        vendor_fee_amount: r.vendorFeeAmount,
        utility_5pct_collateral: r.utilityCollateral,
        additional_collateral_percent: r.additionalCollateralPercent,
        additional_collateral_amount: r.additionalCollateralAmount,
        cc_auth_5pct: r.ccAuth5Percent,
        application_fee: r.applicationFee,
        total_deductions: r.totalDeductions,
        profit: r.profit,
        total_collateralization: r.totalCollateralization,
        needs_review: r.needsReview ? "Yes" : "",
        review_reason: r.reviewReason,
      })),
    );
    triggerCsvDownload(
      `profit-collateralization-${timestampForCsvFileName()}.csv`,
      csv,
    );
  }, [financialProfitData.rows]);

  // -------------------------------------------------------------------------
  // Render system name link (uses parent's sheet opener callback)
  // -------------------------------------------------------------------------
  const systemNameLink = (systemName: string, systemKey: string) => (
    <button
      type="button"
      className="text-left font-medium text-blue-700 hover:text-blue-900 hover:underline cursor-pointer"
      onClick={() => onSelectSystem(systemKey)}
    >
      {systemName}
    </button>
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-4 mt-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Card className="border-rose-200 bg-rose-50/50">
          <CardHeader>
            <CardDescription>Revenue at Risk</CardDescription>
            <CardTitle className="text-2xl text-rose-800">
              ${formatNumber(financialRevenueAtRisk.total)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>% of Portfolio</CardDescription>
            <CardTitle className="text-2xl">
              {financialRevenueAtRisk.percent !== null
                ? `${financialRevenueAtRisk.percent.toFixed(1)}%`
                : "N/A"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Systems at Risk</CardDescription>
            <CardTitle className="text-2xl">{financialRevenueAtRisk.systems.length}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {financialRevenueAtRisk.byType.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Revenue at Risk by Category</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48 rounded-md border border-slate-200 bg-white p-2 mb-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={financialRevenueAtRisk.byType}
                  margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="type" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(v: number) => `$${formatNumber(v)}`} />
                  <Bar dataKey="value" fill="#ef4444" name="Value at Risk" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Systems at Risk</CardTitle>
              <CardDescription>
                Systems with contracted value that are offline or terminated.
              </CardDescription>
            </div>
            {financialRevenueAtRisk.systems.length > 0 && (
              <Button variant="outline" size="sm" onClick={downloadRevenueAtRiskCsv}>
                Export CSV
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {financialRevenueAtRisk.systems.length === 0 ? (
            <p className="text-sm text-emerald-600 py-4 text-center">
              No systems at risk. All contracted systems are reporting.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>System</TableHead>
                  <TableHead>Risk Type</TableHead>
                  <TableHead className="text-right">Contract Value</TableHead>
                  <TableHead>Last Reporting</TableHead>
                  <TableHead className="text-right">Days Offline</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {financialRevenueAtRisk.systems.slice(0, 50).map((s, i) => {
                  const matchedSys = systems.find((sys) => sys.systemName === s.name);
                  return (
                    <TableRow key={i}>
                      <TableCell>
                        {matchedSys ? (
                          systemNameLink(s.name, matchedSys.key)
                        ) : (
                          <span className="font-medium">{s.name}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={s.riskType === "Offline" ? "destructive" : "secondary"}>
                          {s.riskType}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">${formatNumber(s.value)}</TableCell>
                      <TableCell>{s.lastDate}</TableCell>
                      <TableCell className="text-right">{s.daysOffline}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Profit & Collateralization Section ───────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card className="border-emerald-200 bg-emerald-50/50">
          <CardHeader>
            <CardDescription>Total Profit (Vendor Fee)</CardDescription>
            <CardTitle className="text-2xl text-emerald-800">
              ${formatNumber(financialProfitData.totalProfit)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Avg Profit / System</CardDescription>
            <CardTitle className="text-2xl">${formatNumber(financialProfitData.avgProfit)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Total Collateralization</CardDescription>
            <CardTitle className="text-2xl">
              ${formatNumber(financialProfitData.totalCollateralization)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Systems w/ Data</CardDescription>
            <CardTitle className="text-2xl">{financialProfitData.systemsWithData}</CardTitle>
          </CardHeader>
        </Card>
        <Card className={financialFlaggedCount > 0 ? "border-amber-200 bg-amber-50/50" : ""}>
          <CardHeader>
            <CardDescription>Needs Review (&gt;30% Coll.)</CardDescription>
            <CardTitle
              className={`text-2xl ${financialFlaggedCount > 0 ? "text-amber-800" : ""}`}
            >
              {financialFlaggedCount}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {financialProfitData.rows.length === 0 && financialCsgIds.length === 0 && (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardContent className="py-4">
            <p className="text-sm text-amber-800">
              Upload the ABP CSG-System Mapping, ICC Report 3, and complete a contract
              scan job on the{" "}
              <a href="/contract-scrape-manager" className="underline font-medium">
                Contract Scraper
              </a>{" "}
              page to see profit and collateralization analysis.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Financials debug panel — walks the join chain financialProfitData
          uses and shows where rows are being dropped. */}
      <Card className="border-slate-200">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Financials data flow debug</CardTitle>
          <CardDescription>
            Walks the same join chain the profit table uses, counting attrition at every
            step. Use this to identify which dataset or which join is dropping rows.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <details>
            <summary className="text-xs cursor-pointer text-slate-600 hover:text-slate-900">
              Expand diagnostic (final result:{" "}
              {formatNumber(financialProfitDebug.chain.final)} profit rows)
            </summary>
            <div className="mt-3 space-y-3 text-xs font-mono">
              <div>
                <p className="font-bold uppercase tracking-wider text-[10px] text-slate-500 mb-1">
                  Query state
                </p>
                <ul className="space-y-0.5">
                  <li>
                    getContractScanResultsByCsgIds enabled:{" "}
                    <span
                      className={
                        financialProfitDebug.queryEnabled
                          ? "text-emerald-700"
                          : "text-rose-700"
                      }
                    >
                      {String(financialProfitDebug.queryEnabled)}
                    </span>
                  </li>
                  <li>
                    query status:{" "}
                    <span
                      className={
                        financialProfitDebug.queryStatus === "error"
                          ? "text-rose-700 font-bold"
                          : ""
                      }
                    >
                      {financialProfitDebug.queryStatus}
                    </span>
                  </li>
                  <li>query fetching: {String(financialProfitDebug.queryFetching)}</li>
                  {financialProfitDebug.queryErrorMessage && (
                    <li className="text-rose-700">
                      error: {financialProfitDebug.queryErrorMessage}
                    </li>
                  )}
                </ul>
              </div>
              <div>
                <p className="font-bold uppercase tracking-wider text-[10px] text-slate-500 mb-1">
                  Input dataset row counts
                </p>
                <ul className="space-y-0.5">
                  <li>
                    part2VerifiedAbpRows:{" "}
                    <strong>{formatNumber(financialProfitDebug.counts.part2VerifiedAbpRows)}</strong>
                  </li>
                  <li>
                    abpCsgSystemMapping rows:{" "}
                    <strong>{formatNumber(financialProfitDebug.counts.mappingRows)}</strong>
                  </li>
                  <li>
                    abpIccReport3Rows:{" "}
                    <strong>{formatNumber(financialProfitDebug.counts.iccReport3Rows)}</strong>
                  </li>
                  <li>
                    financialCsgIds (passed to query):{" "}
                    <strong>{formatNumber(financialProfitDebug.counts.financialCsgIdsCount)}</strong>
                  </li>
                  <li>
                    contractScanResults returned by query:{" "}
                    <strong>{formatNumber(financialProfitDebug.counts.scanResultsReturned)}</strong>
                  </li>
                </ul>
              </div>
              <div>
                <p className="font-bold uppercase tracking-wider text-[10px] text-slate-500 mb-1">
                  Join chain attrition
                </p>
                <ul className="space-y-0.5">
                  <li>
                    iterated part2VerifiedAbpRows:{" "}
                    <strong>{formatNumber(financialProfitDebug.chain.iterated)}</strong>
                  </li>
                  <li>
                    ↳ with non-empty Application_ID:{" "}
                    <strong>{formatNumber(financialProfitDebug.chain.withAppId)}</strong>
                  </li>
                  <li>
                    ↳ with csgId in mapping:{" "}
                    <strong>{formatNumber(financialProfitDebug.chain.withCsgId)}</strong>
                  </li>
                  <li>
                    ↳ with scan result for that csgId:{" "}
                    <strong>{formatNumber(financialProfitDebug.chain.withScan)}</strong>
                  </li>
                  <li>
                    ↳ with ICC Report row for appId:{" "}
                    <strong>{formatNumber(financialProfitDebug.chain.withIcc)}</strong>
                  </li>
                  <li>
                    FINAL (scan AND icc both present):{" "}
                    <strong className="text-emerald-700">
                      {formatNumber(financialProfitDebug.chain.final)}
                    </strong>
                  </li>
                </ul>
              </div>
              <div>
                <p className="font-bold uppercase tracking-wider text-[10px] text-slate-500 mb-1">
                  Sample IDs (first 5 of each — eyeball for mismatches)
                </p>
                <ul className="space-y-0.5">
                  <li>
                    mapping csgIds: [
                    {financialProfitDebug.samples.mappingCsgIds.join(", ") || "(empty)"}]
                  </li>
                  <li>
                    scan result csgIds: [
                    {financialProfitDebug.samples.scanCsgIds.join(", ") || "(empty)"}]
                  </li>
                  <li>
                    mapping appIds: [
                    {financialProfitDebug.samples.mappingAppIds.join(", ") || "(empty)"}]
                  </li>
                  <li>
                    ICC report appIds: [
                    {financialProfitDebug.samples.iccAppIds.join(", ") || "(empty)"}]
                  </li>
                  <li>
                    part2 verified appIds: [
                    {financialProfitDebug.samples.part2AppIds.join(", ") || "(empty)"}]
                  </li>
                </ul>
              </div>
              <div>
                <p className="font-bold uppercase tracking-wider text-[10px] text-slate-500 mb-1">
                  ICC Report 3 column analysis
                </p>
                <ul className="space-y-0.5">
                  <li>
                    CSV headers (first 20):{" "}
                    {financialProfitDebug.icc.headers.length > 0
                      ? `[${financialProfitDebug.icc.headers.join(", ")}]`
                      : "(no headers)"}
                  </li>
                  <li>
                    appId field match:{" "}
                    <span
                      className={
                        financialProfitDebug.icc.appIdFieldFound.length > 0
                          ? "text-emerald-700"
                          : "text-rose-700 font-bold"
                      }
                    >
                      {financialProfitDebug.icc.appIdFieldFound.length > 0
                        ? financialProfitDebug.icc.appIdFieldFound.join(", ")
                        : "NONE — expected 'Application ID', 'Application_ID', or 'application_id'"}
                    </span>
                  </li>
                  <li>
                    contract value field match:{" "}
                    <span
                      className={
                        financialProfitDebug.icc.contractValueFieldFound.length > 0
                          ? "text-emerald-700"
                          : "text-rose-700 font-bold"
                      }
                    >
                      {financialProfitDebug.icc.contractValueFieldFound.length > 0
                        ? financialProfitDebug.icc.contractValueFieldFound.join(", ")
                        : "NONE — expected 'Total REC Delivery Contract Value', 'REC Delivery Contract Value', or 'Total Contract Value'"}
                    </span>
                  </li>
                </ul>
              </div>
              <p className="text-[10px] text-slate-500 italic">
                Diagnostic added 2026-04-11 to debug "contract scraper data not reaching
                Financials". If the chain shows withScan=0 but withCsgId&gt;0, the csgIds
                in your mapping don't match what the scraper has. If withScan&gt;0 but
                final=0, ICC Report 3 is missing rows for those appIds.
              </p>
            </div>
          </details>
        </CardContent>
      </Card>

      {financialProfitData.rows.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Profit & Collateralization by System</CardTitle>
                <CardDescription>
                  Part II verified systems only. Profit = vendor fee. Collateral &gt; 30%
                  of GCV flagged for review.
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={downloadProfitTableCsv}>
                Export CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* ── Filter / search controls ───────────────────── */}
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={financialSearch}
                onChange={(e) => setFinancialSearch(e.target.value)}
                placeholder="Search system, app ID, CSG ID…"
                className="flex-1 min-w-[180px] rounded-sm border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <select
                value={financialFilter}
                onChange={(e) =>
                  setFinancialFilter(e.target.value as "all" | "needs-review" | "ok")
                }
                className="rounded-sm border bg-background px-2 py-1.5 text-xs"
              >
                <option value="all">All ({formatNumber(financialProfitData.rows.length)})</option>
                <option value="needs-review">
                  Needs Review ({formatNumber(financialFlaggedCount)})
                </option>
                <option value="ok">
                  OK ({formatNumber(financialProfitData.rows.length - financialFlaggedCount)})
                </option>
              </select>
              <span className="text-xs text-muted-foreground">
                Showing {formatNumber(Math.min(100, filteredFinancialRows.length))} of{" "}
                {formatNumber(filteredFinancialRows.length)}
              </span>
              {!batchRescanRunning ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  disabled={filteredFinancialRows.length === 0}
                  onClick={handleBatchRescan}
                >
                  Re-scan All Filtered ({formatNumber(filteredFinancialRows.length)})
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs border-red-300 text-red-700"
                  onClick={() => {
                    batchRescanCancelledRef.current = true;
                  }}
                >
                  Stop Batch
                </Button>
              )}
            </div>
            {/* ── Batch rescan progress ───────────────────────── */}
            {rescanStatuses.size > 0 && (
              <div className="flex items-center gap-3 text-xs">
                <Progress
                  value={
                    rescanStatuses.size > 0
                      ? (Array.from(rescanStatuses.values()).filter(
                          (s) => s.status === "completed" || s.status === "error",
                        ).length /
                          rescanStatuses.size) *
                        100
                      : 0
                  }
                  className="h-2 flex-1"
                />
                <span className="text-muted-foreground whitespace-nowrap">
                  {formatNumber(
                    Array.from(rescanStatuses.values()).filter(
                      (s) => s.status === "completed" || s.status === "error",
                    ).length,
                  )}
                  {" / "}
                  {formatNumber(rescanStatuses.size)} scanned
                  {Array.from(rescanStatuses.values()).filter((s) => s.status === "error")
                    .length > 0 && (
                    <span className="text-red-600 ml-1">
                      (
                      {
                        Array.from(rescanStatuses.values()).filter(
                          (s) => s.status === "error",
                        ).length
                      }{" "}
                      errors)
                    </span>
                  )}
                </span>
                {!batchRescanRunning && rescanStatuses.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-2 text-[10px] text-muted-foreground"
                    onClick={() => setRescanStatuses(new Map())}
                  >
                    Clear
                  </Button>
                )}
              </div>
            )}
            {/* ── Table ────────────────────────────────────────── */}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50"
                      onClick={() => handleFinancialSort("systemName")}
                    >
                      System{financialSortIndicator("systemName")}
                    </TableHead>
                    <TableHead>App ID</TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50 text-right"
                      onClick={() => handleFinancialSort("grossContractValue")}
                    >
                      Gross Contract{financialSortIndicator("grossContractValue")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50 text-right"
                      onClick={() => handleFinancialSort("vendorFeePercent")}
                    >
                      Vendor Fee %{financialSortIndicator("vendorFeePercent")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50 text-right"
                      onClick={() => handleFinancialSort("vendorFeeAmount")}
                    >
                      Vendor Fee ${financialSortIndicator("vendorFeeAmount")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50 text-right"
                      onClick={() => handleFinancialSort("utilityCollateral")}
                    >
                      Utility 5%{financialSortIndicator("utilityCollateral")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50 text-right"
                      onClick={() => handleFinancialSort("additionalCollateralPercent")}
                    >
                      Add. Coll. %{financialSortIndicator("additionalCollateralPercent")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50 text-right"
                      onClick={() => handleFinancialSort("additionalCollateralAmount")}
                    >
                      Add. Coll. ${financialSortIndicator("additionalCollateralAmount")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50 text-right"
                      onClick={() => handleFinancialSort("ccAuth5Percent")}
                    >
                      CC Auth 5%{financialSortIndicator("ccAuth5Percent")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50 text-right"
                      onClick={() => handleFinancialSort("applicationFee")}
                    >
                      App Fee{financialSortIndicator("applicationFee")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50 text-right"
                      onClick={() => handleFinancialSort("totalDeductions")}
                    >
                      Total Ded.{financialSortIndicator("totalDeductions")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50 text-right"
                      onClick={() => handleFinancialSort("profit")}
                    >
                      Profit{financialSortIndicator("profit")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none hover:bg-slate-50 text-right"
                      onClick={() => handleFinancialSort("totalCollateralization")}
                    >
                      Total Coll.{financialSortIndicator("totalCollateralization")}
                    </TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                    {rescanStatuses.size > 0 && (
                      <>
                        <TableHead>Scan Status</TableHead>
                        <TableHead>Changes</TableHead>
                      </>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredFinancialRows.slice(0, 100).map((r) => (
                    <TableRow
                      key={r.csgId}
                      className={
                        r.needsReview ? "bg-amber-50/60 border-l-2 border-amber-400" : ""
                      }
                    >
                      <TableCell className="font-medium text-xs max-w-[160px] truncate">
                        {r.needsReview && (
                          <span className="text-amber-600 mr-1" title={r.reviewReason}>
                            ⚠
                          </span>
                        )}
                        {r.systemName}
                      </TableCell>
                      <TableCell className="text-xs">{r.applicationId}</TableCell>
                      <TableCell className="text-right">
                        ${formatNumber(r.grossContractValue)}
                      </TableCell>
                      <TableCell className="text-right">{r.vendorFeePercent}%</TableCell>
                      <TableCell className="text-right">
                        ${formatNumber(r.vendorFeeAmount)}
                      </TableCell>
                      <TableCell className="text-right">
                        ${formatNumber(r.utilityCollateral)}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.additionalCollateralPercent}%
                      </TableCell>
                      <TableCell className="text-right">
                        ${formatNumber(r.additionalCollateralAmount)}
                      </TableCell>
                      <TableCell className="text-right">
                        ${formatNumber(r.ccAuth5Percent)}
                      </TableCell>
                      <TableCell className="text-right">
                        ${formatNumber(r.applicationFee)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        ${formatNumber(r.totalDeductions)}
                      </TableCell>
                      <TableCell className="text-right font-semibold text-emerald-700">
                        ${formatNumber(r.profit)}
                      </TableCell>
                      <TableCell className="text-right">
                        ${formatNumber(r.totalCollateralization)}
                      </TableCell>
                      <TableCell>
                        {r.hasOverride && (
                          <Badge
                            variant="secondary"
                            className="bg-blue-100 text-blue-800 border-blue-200 text-[10px] mr-1"
                          >
                            Edited
                          </Badge>
                        )}
                        {r.needsReview ? (
                          <Badge
                            variant="secondary"
                            className="bg-amber-100 text-amber-800 border-amber-200 text-[10px]"
                          >
                            Review
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">
                            OK
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            onClick={() =>
                              setEditingFinancialRow({
                                csgId: r.csgId,
                                systemName: r.systemName,
                                vendorFeePercent: String(r.vendorFeePercent),
                                additionalCollateralPercent: String(
                                  r.additionalCollateralPercent,
                                ),
                                notes: "",
                              })
                            }
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            disabled={rescanSingleContract.isPending}
                            onClick={async () => {
                              try {
                                const result = await rescanSingleContract.mutateAsync({
                                  csgId: r.csgId,
                                });
                                toast.success(
                                  `Re-scanned CSG ${r.csgId}: vendor fee ${
                                    result.vendorFeePercent ?? "N/A"
                                  }%, collateral ${
                                    result.additionalCollateralPercent ?? "N/A"
                                  }%`,
                                );
                                // PR #337 follow-up item 5 + PR #338
                                // follow-up item 5 (2026-05-04 / 05-05) —
                                // parallel refetch of the two independent
                                // heavy queries; the slim KPI invalidate
                                // must come AFTER both because the heavy
                                // financials refetch is what writes the
                                // side cache. Mirrors the batch-rescan
                                // pattern.
                                await Promise.all([
                                  contractScanRefetch(),
                                  financialsRefetch(),
                                ]);
                                await invalidateFinancialKpiSummary();
                              } catch (err) {
                                toast.error(
                                  err instanceof Error ? err.message : "Re-scan failed",
                                );
                              }
                            }}
                          >
                            Re-scan
                          </Button>
                        </div>
                      </TableCell>
                      {rescanStatuses.size > 0 &&
                        (() => {
                          const entry = rescanStatuses.get(r.csgId);
                          return (
                            <>
                              <TableCell>
                                {!entry && (
                                  <span className="text-xs text-muted-foreground">—</span>
                                )}
                                {entry?.status === "queued" && (
                                  <Badge
                                    variant="secondary"
                                    className="bg-gray-100 text-gray-700 text-[10px]"
                                  >
                                    Queued
                                  </Badge>
                                )}
                                {entry?.status === "active" && (
                                  <Badge
                                    variant="secondary"
                                    className="bg-blue-100 text-blue-700 text-[10px]"
                                  >
                                    <Loader2 className="h-3 w-3 animate-spin mr-1 inline" />
                                    Scanning
                                  </Badge>
                                )}
                                {entry?.status === "completed" && (
                                  <Badge
                                    variant="secondary"
                                    className="bg-green-100 text-green-700 text-[10px]"
                                  >
                                    Done
                                  </Badge>
                                )}
                                {entry?.status === "error" && (
                                  <Badge
                                    variant="secondary"
                                    className="bg-red-100 text-red-700 text-[10px]"
                                    title={entry.error}
                                  >
                                    Error
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell
                                className="text-xs max-w-[200px] truncate"
                                title={entry?.changes || entry?.error || ""}
                              >
                                {entry?.status === "completed" &&
                                  (entry.changes || "No changes")}
                                {entry?.status === "error" && (
                                  <span className="text-red-600">{entry.error}</span>
                                )}
                              </TableCell>
                            </>
                          );
                        })()}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {filteredFinancialRows.length > 100 && (
              <p className="text-xs text-muted-foreground text-center">
                Showing 100 of {formatNumber(filteredFinancialRows.length)} systems.
                Export CSV for full data.
              </p>
            )}

            {/* Edit override dialog */}
            {editingFinancialRow && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md space-y-4">
                  <h3 className="font-semibold text-base">
                    Edit Contract — CSG {editingFinancialRow.csgId}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {editingFinancialRow.systemName}
                  </p>
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-sm font-medium">Vendor Fee %</label>
                      <Input
                        type="number"
                        step="0.01"
                        value={editingFinancialRow.vendorFeePercent}
                        onChange={(e) =>
                          setEditingFinancialRow((prev) =>
                            prev ? { ...prev, vendorFeePercent: e.target.value } : null,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium">Additional Collateral %</label>
                      <Input
                        type="number"
                        step="0.01"
                        value={editingFinancialRow.additionalCollateralPercent}
                        onChange={(e) =>
                          setEditingFinancialRow((prev) =>
                            prev
                              ? { ...prev, additionalCollateralPercent: e.target.value }
                              : null,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium">Notes (optional)</label>
                      <Input
                        value={editingFinancialRow.notes}
                        onChange={(e) =>
                          setEditingFinancialRow((prev) =>
                            prev ? { ...prev, notes: e.target.value } : null,
                          )
                        }
                        placeholder="Reason for override..."
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingFinancialRow(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={updateContractOverride.isPending}
                      onClick={saveOverride}
                    >
                      {updateContractOverride.isPending ? "Saving..." : "Save Override"}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <AskAiPanel
        moduleKey="solar-rec-financials"
        title="Ask AI about financials"
        contextGetter={() => ({
          profitSummary: {
            totalProfit: financialProfitData.totalProfit,
            avgProfit: financialProfitData.avgProfit,
            systemsWithData: financialProfitData.systemsWithData,
            totalCollateralization:
              financialProfitData.totalCollateralization,
            totalUtilityCollateral:
              financialProfitData.totalUtilityCollateral,
            totalAdditionalCollateral:
              financialProfitData.totalAdditionalCollateral,
            totalCcAuth: financialProfitData.totalCcAuth,
          },
          revenueAtRisk: {
            total: financialRevenueAtRisk.total,
            percent: financialRevenueAtRisk.percent,
            byType: financialRevenueAtRisk.byType,
            topAtRiskSystems: financialRevenueAtRisk.systems.slice(0, 20),
          },
          profitDebug: {
            queryStatus: financialProfitDebug.queryStatus,
            queryEnabled: financialProfitDebug.queryEnabled,
            queryErrorMessage: financialProfitDebug.queryErrorMessage,
            counts: financialProfitDebug.counts,
            chain: financialProfitDebug.chain,
          },
          flaggedCount: financialFlaggedCount,
          sampleFlaggedRows: filteredFinancialRows.slice(0, 20),
        })}
      />
    </div>
  );
});
