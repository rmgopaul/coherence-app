/**
 * Ownership Status tab.
 *
 * Phase 2 PR-E follow-up: reads the derived ownership fact table via
 * `getDashboardOwnershipPage` instead of receiving a legacy
 * all-systems slice from the parent. That keeps tab activation off
 * the oversized offlineMonitoring/system-snapshot path.
 */

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { AskAiPanel } from "@/components/AskAiPanel";
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
import {
  formatDate,
  standingBadgeClass,
} from "@/solar-rec-dashboard/lib/helpers";
import {
  dashboardTransientRetryDelay,
  shouldRetryDashboardTransient,
} from "@/solar-rec-dashboard/lib/dashboardRetryPolicy";
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
import { useDashboardBuildControl } from "@/solar-rec-dashboard/hooks/useDashboardBuildControl";
import { DashboardBuildProgressBar } from "@/solar-rec-dashboard/components/DashboardBuildProgressBar";
import type { SolarRecAppRouter } from "@server/_core/solarRecRouter";
import {
  ALL_STANDING_VALUES,
  type Standing,
} from "@shared/solarRecStanding";

// ---------------------------------------------------------------------------
// Types/constants
// ---------------------------------------------------------------------------

type RouterOutputs = inferRouterOutputs<SolarRecAppRouter>;
type OwnershipPageOutput =
  RouterOutputs["solarRecDashboard"]["getDashboardOwnershipPage"];
type OwnershipPageRow = OwnershipPageOutput["rows"][number];
type OwnershipSourceFilter = "All" | "Matched System" | "Part II Unmatched";

const OWNERSHIP_PAGE_SIZE = 200;

function toDateOrNull(value: Date | string | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function OwnershipTab() {
  // B3-final: filter axis switched from the legacy 6-value
  // `OwnershipStatus` enum to the 9-value `Standing` taxonomy. The
  // dropdown enumerates `ALL_STANDING_VALUES` directly so operators
  // can pick any specific tier (drill-in by per-row badge if needed).
  const [standingFilter, setStandingFilter] = useState<Standing | "All">(
    "All",
  );
  const [sourceFilter, setSourceFilter] =
    useState<OwnershipSourceFilter>("All");
  const [searchTerm, setSearchTerm] = useState("");
  const [cursorAfter, setCursorAfter] = useState<string | null>(null);
  const [ownershipRows, setOwnershipRows] = useState<OwnershipPageRow[]>([]);
  // Phase 18: defer the search string so filteredOwnershipRows
  // re-runs as a low-priority update, keeping keystrokes responsive.
  const deferredSearchTerm = useDeferredValue(searchTerm);

  const utils = solarRecTrpc.useUtils();
  const ownershipPageQuery =
    solarRecTrpc.solarRecDashboard.getDashboardOwnershipPage.useQuery(
      {
        // Wire-level field is `cursor` (PR-D-4 renamed
        // `cursorAfter` → `cursor` to match
        // `getDatasetRowsPage` + the tRPC v11 `useInfiniteQuery`
        // convention). Keep the local state name unchanged —
        // it's an internal handle, not the wire contract.
        cursor: cursorAfter,
        limit: OWNERSHIP_PAGE_SIZE,
        // B3-final: filter by Standing. The proc accepts a new
        // `standing` input that filters the fact-table column added
        // in PR B2 (#649). Legacy `status: ownershipStatus` input
        // stays alive on the proc for backward compatibility (this
        // PR doesn't drop it) but the tab no longer sends it.
        standing: standingFilter === "All" ? null : standingFilter,
        source: sourceFilter === "All" ? null : sourceFilter,
      },
      {
        staleTime: 60_000,
        // 2026-05-09 — Bug #1 (502 cascade) resilience. Same
        // shared retry policy as ComparisonsTab + AlertsTab.
        retry: shouldRetryDashboardTransient,
        retryDelay: dashboardTransientRetryDelay,
      },
    );

  useEffect(() => {
    if (!ownershipPageQuery.data) return;
    setOwnershipRows((previous) => {
      if (cursorAfter === null) return ownershipPageQuery.data.rows;
      const bySystemKey = new Map(previous.map((row) => [row.systemKey, row]));
      for (const row of ownershipPageQuery.data.rows) {
        bySystemKey.set(row.systemKey, row);
      }
      return Array.from(bySystemKey.values());
    });
  }, [cursorAfter, ownershipPageQuery.data]);

  const resetPaging = useCallback(() => {
    setCursorAfter(null);
    setOwnershipRows([]);
  }, []);

  const handleBuildSucceeded = useCallback(() => {
    resetPaging();
    return utils.solarRecDashboard.getDashboardOwnershipPage.invalidate();
  }, [resetPaging, utils]);

  const { buildErrorMessage, isBuildRunning, buildProgress, startBuild } =
    useDashboardBuildControl({
      onSucceeded: handleBuildSucceeded,
    });

  const filteredOwnershipRows = useMemo(() => {
    const normalizedSearch = deferredSearchTerm.trim().toLowerCase();
    return ownershipRows.filter((system) => {
      if (!normalizedSearch) return true;

      const haystack = [
        system.systemName,
        system.part2ProjectName,
        system.systemId ?? "",
        system.trackingSystemRefId ?? "",
        system.part2TrackingId ?? "",
        system.contractStatusText,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }, [ownershipRows, deferredSearchTerm]);

  const nextCursor = ownershipPageQuery.data?.nextCursor ?? null;
  const hasMore = ownershipPageQuery.data?.hasMore ?? false;

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Ownership Status Classifier
          </CardTitle>
          <CardDescription>
            Categories: Transferred, Not Transferred, and Terminated crossed
            with Reporting / Not Reporting.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Filter by category
              </label>
              <select
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={standingFilter}
                onChange={(event) => {
                  setStandingFilter(
                    event.target.value as Standing | "All",
                  );
                  resetPaging();
                }}
              >
                <option value="All">All Categories</option>
                {ALL_STANDING_VALUES.map((standing) => (
                  <option key={standing} value={standing}>
                    {standing}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Filter by source
              </label>
              <select
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={sourceFilter}
                onChange={(event) => {
                  setSourceFilter(event.target.value as OwnershipSourceFilter);
                  resetPaging();
                }}
              >
                <option value="All">All Sources</option>
                <option value="Matched System">Matched System</option>
                <option value="Part II Unmatched">Part II Unmatched</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Search
              </label>
              <Input
                placeholder="System, project, ID, tracking..."
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            <div className="text-slate-700">
              Showing {filteredOwnershipRows.length.toLocaleString()} of{" "}
              {ownershipRows.length.toLocaleString()} loaded rows
              {hasMore ? " (more available)" : ""}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  resetPaging();
                  void utils.solarRecDashboard.getDashboardOwnershipPage.invalidate();
                }}
                disabled={ownershipPageQuery.isFetching}
              >
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={startBuild}
                disabled={isBuildRunning}
              >
                {isBuildRunning ? "Building..." : "Rebuild table"}
              </Button>
            </div>
          </div>

          <DashboardBuildProgressBar
            isBuildRunning={isBuildRunning}
            progress={buildProgress}
          />

          {buildErrorMessage ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
              {buildErrorMessage}
            </div>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>System</TableHead>
                <TableHead>system_id</TableHead>
                <TableHead>Tracking ID</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status Category</TableHead>
                <TableHead>Reporting?</TableHead>
                <TableHead>Transferred?</TableHead>
                <TableHead>Terminated?</TableHead>
                <TableHead>Contract Type</TableHead>
                <TableHead>Last Reporting Date</TableHead>
                <TableHead>Contracted Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredOwnershipRows.map((system) => (
                <TableRow key={system.systemKey}>
                  <TableCell className="font-medium">
                    {system.systemName || system.part2ProjectName || "N/A"}
                  </TableCell>
                  <TableCell>{system.systemId ?? "N/A"}</TableCell>
                  <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                  <TableCell>{system.source}</TableCell>
                  <TableCell>
                    {system.standing ? (
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium whitespace-nowrap ${standingBadgeClass(
                          system.standing as Standing,
                        )}`}
                      >
                        {system.standing}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </TableCell>
                  <TableCell>{system.isReporting ? "Yes" : "No"}</TableCell>
                  <TableCell>{system.isTransferred ? "Yes" : "No"}</TableCell>
                  <TableCell>{system.isTerminated ? "Yes" : "No"}</TableCell>
                  <TableCell>{system.contractType ?? "N/A"}</TableCell>
                  <TableCell>
                    {formatDate(toDateOrNull(system.latestReportingDate))}
                  </TableCell>
                  <TableCell>
                    {formatDate(toDateOrNull(system.contractedDate))}
                  </TableCell>
                </TableRow>
              ))}
              {filteredOwnershipRows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={11}
                    className="py-6 text-center text-sm text-slate-500"
                  >
                    {ownershipPageQuery.isLoading
                      ? "Loading ownership rows..."
                      : "No ownership rows found."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>

          {hasMore ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (nextCursor) setCursorAfter(nextCursor);
                }}
                disabled={!nextCursor || ownershipPageQuery.isFetching}
              >
                {ownershipPageQuery.isFetching ? "Loading..." : "Load more"}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <AskAiPanel
        moduleKey="solar-rec-ownership-status"
        title="Ask AI about ownership status"
        contextGetter={() => {
          const counts = new Map<string, number>();
          for (const s of ownershipRows) {
            const key = s.standing ?? "(none)";
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          return {
            loadedRows: ownershipRows.length,
            byStanding: Array.from(counts.entries()).map(
              ([standing, count]) => ({ standing, count }),
            ),
            filters: {
              category: standingFilter,
              source: sourceFilter,
              search: deferredSearchTerm || null,
            },
            filteredCount: filteredOwnershipRows.length,
            sampleFilteredSystems: filteredOwnershipRows
              .slice(0, 20)
              .map((s) => ({
                systemName: s.systemName,
                systemId: s.systemId,
                trackingSystemRefId: s.trackingSystemRefId,
                source: s.source,
                standing: s.standing,
                isReporting: s.isReporting,
                isTransferred: s.isTransferred,
                isTerminated: s.isTerminated,
                contractType: s.contractType,
                latestReportingDate: s.latestReportingDate
                  ? (toDateOrNull(s.latestReportingDate)
                      ?.toISOString()
                      .slice(0, 10) ?? null)
                  : null,
                contractedDate: s.contractedDate
                  ? (toDateOrNull(s.contractedDate)
                      ?.toISOString()
                      .slice(0, 10) ?? null)
                  : null,
              })),
          };
        }}
      />
    </div>
  );
});
