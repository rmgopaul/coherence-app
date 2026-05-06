/**
 * Ownership Status tab.
 *
 * Phase 2 PR-E follow-up: reads the derived ownership fact table via
 * `getDashboardOwnershipPage` instead of receiving a legacy
 * all-systems slice from the parent. That keeps tab activation off
 * the oversized offlineMonitoring/system-snapshot path.
 */

import { memo, useDeferredValue, useEffect, useMemo, useState } from "react";
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
  ownershipBadgeClass,
} from "@/solar-rec-dashboard/lib/helpers";
import { OWNERSHIP_ORDER } from "@/solar-rec-dashboard/lib/constants";
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
import type { SolarRecAppRouter } from "@server/_core/solarRecRouter";
import type { OwnershipStatus } from "@/solar-rec-dashboard/state/types";

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

function isTerminalBuildStatus(status: string | null | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "notFound";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function OwnershipTab() {
  const [ownershipFilter, setOwnershipFilter] = useState<
    OwnershipStatus | "All"
  >("All");
  const [sourceFilter, setSourceFilter] =
    useState<OwnershipSourceFilter>("All");
  const [searchTerm, setSearchTerm] = useState("");
  const [cursorAfter, setCursorAfter] = useState<string | null>(null);
  const [ownershipRows, setOwnershipRows] = useState<OwnershipPageRow[]>([]);
  const [activeBuildId, setActiveBuildId] = useState<string | null>(null);
  const [processedBuildId, setProcessedBuildId] = useState<string | null>(null);
  const [buildErrorMessage, setBuildErrorMessage] = useState<string | null>(
    null
  );
  // Phase 18: defer the search string so filteredOwnershipRows
  // re-runs as a low-priority update, keeping keystrokes responsive.
  const deferredSearchTerm = useDeferredValue(searchTerm);

  const utils = solarRecTrpc.useUtils();
  const startDashboardBuild =
    solarRecTrpc.solarRecDashboard.startDashboardBuild.useMutation();
  const ownershipPageQuery =
    solarRecTrpc.solarRecDashboard.getDashboardOwnershipPage.useQuery(
      {
        cursorAfter,
        limit: OWNERSHIP_PAGE_SIZE,
        status: ownershipFilter === "All" ? null : ownershipFilter,
        source: sourceFilter === "All" ? null : sourceFilter,
      },
      {
        staleTime: 60_000,
        retry: false,
      }
    );
  const buildStatusQuery =
    solarRecTrpc.solarRecDashboard.getDashboardBuildStatus.useQuery(
      { buildId: activeBuildId ?? "__none__" },
      {
        enabled: activeBuildId !== null,
        refetchInterval: (query) => {
          const status = query.state.data?.status;
          if (isTerminalBuildStatus(status)) return false;
          return 2_000;
        },
        retry: false,
        staleTime: 0,
      }
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

  useEffect(() => {
    if (!activeBuildId || processedBuildId === activeBuildId) return;
    const status = buildStatusQuery.data?.status;
    if (status === "succeeded") {
      setProcessedBuildId(activeBuildId);
      setBuildErrorMessage(null);
      setCursorAfter(null);
      setOwnershipRows([]);
      void utils.solarRecDashboard.getDashboardOwnershipPage.invalidate();
    } else if (status === "failed" || status === "notFound") {
      setProcessedBuildId(activeBuildId);
      setBuildErrorMessage(
        buildStatusQuery.data?.errorMessage ??
          "Dashboard build did not complete."
      );
    }
  }, [
    activeBuildId,
    buildStatusQuery.data?.errorMessage,
    buildStatusQuery.data?.status,
    processedBuildId,
    utils,
  ]);

  function resetPaging(): void {
    setCursorAfter(null);
    setOwnershipRows([]);
  }

  async function handleStartBuild(): Promise<void> {
    try {
      setBuildErrorMessage(null);
      const result = await startDashboardBuild.mutateAsync();
      setActiveBuildId(result.buildId);
      setProcessedBuildId(null);
    } catch (error) {
      setBuildErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to start dashboard build."
      );
    }
  }

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

  const buildStatus = buildStatusQuery.data?.status ?? null;
  const isBuildRunning =
    startDashboardBuild.isPending ||
    buildStatus === "queued" ||
    buildStatus === "running";
  const nextCursor = ownershipPageQuery.data?.nextCursor ?? null;
  const hasMore = ownershipPageQuery.data?.hasMore ?? false;

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ownership Status Classifier</CardTitle>
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
                value={ownershipFilter}
                onChange={(event) => {
                  setOwnershipFilter(
                    event.target.value as OwnershipStatus | "All"
                  );
                  resetPaging();
                }}
              >
                <option value="All">All Categories</option>
                {OWNERSHIP_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {status}
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
              <label className="text-sm font-medium text-slate-700">Search</label>
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
                onClick={handleStartBuild}
                disabled={isBuildRunning}
              >
                {isBuildRunning ? "Building..." : "Rebuild table"}
              </Button>
            </div>
          </div>

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
                    <span
                      className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium ${ownershipBadgeClass(
                        system.ownershipStatus as OwnershipStatus,
                      )}`}
                    >
                      {system.ownershipStatus}
                    </span>
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
                  <TableCell colSpan={11} className="py-6 text-center text-sm text-slate-500">
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
            counts.set(
              s.ownershipStatus,
              (counts.get(s.ownershipStatus) ?? 0) + 1
            );
          }
          return {
            loadedRows: ownershipRows.length,
            byOwnershipStatus: Array.from(counts.entries()).map(
              ([status, count]) => ({ status, count })
            ),
            filters: {
              category: ownershipFilter,
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
                ownershipStatus: s.ownershipStatus,
                isReporting: s.isReporting,
                isTransferred: s.isTransferred,
                isTerminated: s.isTerminated,
                contractType: s.contractType,
                latestReportingDate: s.latestReportingDate
                  ? toDateOrNull(s.latestReportingDate)
                      ?.toISOString()
                      .slice(0, 10) ?? null
                  : null,
                contractedDate: s.contractedDate
                  ? toDateOrNull(s.contractedDate)?.toISOString().slice(0, 10) ??
                    null
                  : null,
              })),
          };
        }}
      />
    </div>
  );
});
