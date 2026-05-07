/**
 * Alerts tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 7 of the
 * god-component decomposition. Owns:
 *   - 2 useMemos (alerts, alertSummary)
 *   - The alert detection logic (offline > 90d, delivery pace below 80%,
 *     zero delivered with active contract, stale datasets)
 *
 * Reads system facts through `getDashboardSystemsPage` instead of
 * receiving the parent's legacy `SystemRecord[]` snapshot. Receives
 * the raw datasets bag only for stale-upload timestamps.
 *
 * The parent's `alertSummary.total > 0 ? ` (${alertSummary.total})` : ""`
 * badge in the TabsList no longer fires when off this tab (the alerts
 * memo previously returned [] when off-tab too, so this is no behavior
 * change — the badge was only ever populated while the user was on the
 * Alerts tab).
 */

import { memo, useCallback, useEffect, useMemo } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { AskAiPanel } from "@/components/AskAiPanel";
// Task 5.13 PR-2 (2026-04-27): trendDeliveryPace moved server-side.
// AlertsTab now reads it via tRPC instead of computing it from raw
// `deliveryScheduleBase.rows` + `transferDeliveryLookup`. With this
// PR, AlertsTab no longer reads any raw `datasets[k].rows` — it's
// fully off the row-array consumption path.
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
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
  buildCsv,
  timestampForCsvFileName,
  triggerCsvDownload,
} from "@/solar-rec-dashboard/lib/csvIo";
import { formatNumber } from "@/solar-rec-dashboard/lib/helpers";
import { useDashboardBuildControl } from "@/solar-rec-dashboard/hooks/useDashboardBuildControl";
import type {
  AlertItem,
  CsvDataset,
  DatasetKey,
} from "@/solar-rec-dashboard/state/types";
import type { SolarRecAppRouter } from "@server/_core/solarRecRouter";

// ---------------------------------------------------------------------------
// Types/constants
// ---------------------------------------------------------------------------

type RouterOutputs = inferRouterOutputs<SolarRecAppRouter>;
type SystemsPageOutput =
  RouterOutputs["solarRecDashboard"]["getDashboardSystemsPage"];
type SystemsPageRow = SystemsPageOutput["rows"][number];

const SYSTEMS_PAGE_SIZE = 500;
const OFFLINE_DAYS_THRESHOLD = 90;
const PACE_THRESHOLD = 0.8;
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const;

function parseDecimalString(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = ymd
    ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AlertsTabProps {
  datasets: Partial<Record<DatasetKey, CsvDataset>>;
  /**
   * Whether this tab is currently active. Gates the system-fact walk
   * and the `getDashboardTrendDeliveryPace` query so the network
   * roundtrips only fire when the user is actually viewing alerts.
   */
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function AlertsTab(props: AlertsTabProps) {
  const { datasets, isActive } = props;
  const utils = solarRecTrpc.useUtils();
  const systemsPageQuery =
    solarRecTrpc.solarRecDashboard.getDashboardSystemsPage.useInfiniteQuery(
      { limit: SYSTEMS_PAGE_SIZE },
      {
        enabled: isActive,
        staleTime: 60_000,
        retry: false,
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
        initialCursor: null,
      },
    );

  useEffect(() => {
    if (!isActive) return;
    if (
      systemsPageQuery.hasNextPage &&
      !systemsPageQuery.isFetchingNextPage
    ) {
      void systemsPageQuery.fetchNextPage();
    }
  }, [
    isActive,
    systemsPageQuery.hasNextPage,
    systemsPageQuery.isFetchingNextPage,
    systemsPageQuery.fetchNextPage,
  ]);

  const resetSystemsPageCache = useCallback(
    () => utils.solarRecDashboard.getDashboardSystemsPage.invalidate(),
    [utils],
  );

  const { buildErrorMessage, isBuildRunning, startBuild } =
    useDashboardBuildControl({
      onSucceeded: resetSystemsPageCache,
    });

  const systemRows = useMemo<SystemsPageRow[]>(() => {
    const rows: SystemsPageRow[] = [];
    const seen = new Set<string>();
    for (const page of systemsPageQuery.data?.pages ?? []) {
      for (const row of page.rows) {
        if (seen.has(row.systemKey)) continue;
        seen.add(row.systemKey);
        rows.push(row);
      }
    }
    return rows;
  }, [systemsPageQuery.data]);

  const hasLoadedAllRows =
    systemsPageQuery.status === "success" && !systemsPageQuery.hasNextPage;
  const isLoadingInitialSystemRows =
    isActive && systemsPageQuery.status === "pending";

  // Task 5.13 PR-2: server-side aggregate. The result is identical to
  // what `buildTrendDeliveryPace(deliveryScheduleBase.rows,
  // transferDeliveryLookup)` produced locally — same shape, same
  // values, computed by the same pure function on the server. Cache
  // is keyed by the input batch hashes + UTC day.
  const trendDeliveryPaceQuery =
    solarRecTrpc.solarRecDashboard.getDashboardTrendDeliveryPace.useQuery(
      undefined,
      {
        enabled: isActive,
        staleTime: 60_000,
      }
    );
  const trendDeliveryPace = trendDeliveryPaceQuery.data?.rows ?? [];

  const alerts = useMemo<AlertItem[]>(() => {
    const items: AlertItem[] = [];
    const now = new Date();

    // Offline > 90 days
    systemRows.forEach((sys) => {
      if (sys.isReporting) return;
      const latestReportingDate = toNullableDate(sys.latestReportingDate);
      if (!latestReportingDate) {
        items.push({
          id: `offline-never-${sys.systemKey}`,
          severity: "critical",
          type: "Offline",
          system: sys.systemName,
          message: "Never reported any generation data",
          action: "Check monitoring connection",
        });
        return;
      }
      const daysOffline = Math.floor(
        (now.getTime() - latestReportingDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysOffline > OFFLINE_DAYS_THRESHOLD) {
        items.push({
          id: `offline-${sys.systemKey}`,
          severity: daysOffline > 180 ? "critical" : "warning",
          type: "Offline",
          system: sys.systemName,
          message: `Offline for ${daysOffline} days (last: ${latestReportingDate.toLocaleDateString()})`,
          action: "Verify monitoring access",
        });
      }
    });

    // Delivery pace below 80%
    trendDeliveryPace.forEach((p) => {
      if (p.expectedPace > 10 && p.actualPace / p.expectedPace < PACE_THRESHOLD) {
        items.push({
          id: `pace-${p.contract}`,
          severity: p.actualPace / p.expectedPace < 0.5 ? "critical" : "warning",
          type: "Delivery Pace",
          system: p.contract,
          message: `Delivery at ${p.actualPace.toFixed(0)}% vs expected ${p.expectedPace.toFixed(0)}%`,
          action: "Review contract delivery",
        });
      }
    });

    // Zero delivered with active contract
    systemRows.forEach((sys) => {
      const contractedRecs = parseDecimalString(sys.contractedRecs) ?? 0;
      const deliveredRecs = parseDecimalString(sys.deliveredRecs) ?? 0;
      if (
        contractedRecs > 0 &&
        deliveredRecs === 0 &&
        !sys.isTerminated
      ) {
        items.push({
          id: `zero-delivered-${sys.systemKey}`,
          severity: "warning",
          type: "Zero Delivery",
          system: sys.systemName,
          message: `${formatNumber(contractedRecs)} RECs contracted but 0 delivered`,
          action: "Check generation and REC issuance",
        });
      }
    });

    // Stale datasets
    const DATASET_KEYS = Object.keys(datasets) as Array<keyof typeof datasets>;
    DATASET_KEYS.forEach((key) => {
      const ds = datasets[key];
      if (!ds || !ds.uploadedAt) return;
      const ageDays = Math.floor(
        (now.getTime() - ds.uploadedAt.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (ageDays > 14) {
        items.push({
          id: `stale-${key}`,
          severity: ageDays > 30 ? "warning" : "info",
          type: "Stale Data",
          system: String(key),
          message: `Last updated ${ageDays} days ago`,
          action: "Upload fresh data",
        });
      }
    });

    return items.sort(
      (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
    );
  }, [systemRows, trendDeliveryPace, datasets]);

  const alertSummary = useMemo(
    () => ({
      critical: alerts.filter((a) => a.severity === "critical").length,
      warning: alerts.filter((a) => a.severity === "warning").length,
      info: alerts.filter((a) => a.severity === "info").length,
      total: alerts.length,
    }),
    [alerts],
  );

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
          <div className="text-slate-700">
            Loaded {formatNumber(systemRows.length)} systems
            {hasLoadedAllRows ? "" : " so far"} for alert scanning.
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void resetSystemsPageCache()}
              disabled={systemsPageQuery.isFetching}
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
        </CardContent>
      </Card>

      {buildErrorMessage ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {buildErrorMessage}
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-3">
        <Card className="border-rose-200 bg-rose-50/50">
          <CardHeader>
            <CardDescription>Critical</CardDescription>
            <CardTitle className="text-2xl text-rose-800">{alertSummary.critical}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="border-amber-200 bg-amber-50/50">
          <CardHeader>
            <CardDescription>Warning</CardDescription>
            <CardTitle className="text-2xl text-amber-800">{alertSummary.warning}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="border-sky-200 bg-sky-50/50">
          <CardHeader>
            <CardDescription>Info</CardDescription>
            <CardTitle className="text-2xl text-sky-800">{alertSummary.info}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">All Alerts</CardTitle>
              <CardDescription>
                {alerts.length} alerts detected across your portfolio.
              </CardDescription>
            </div>
            {alerts.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const csv = buildCsv(
                    ["severity", "type", "system", "message", "action"],
                    alerts.map((a) => ({
                      severity: a.severity,
                      type: a.type,
                      system: a.system,
                      message: a.message,
                      action: a.action,
                    })),
                  );
                  triggerCsvDownload(`alerts-${timestampForCsvFileName()}.csv`, csv);
                }}
              >
                Export CSV
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingInitialSystemRows ? (
            <p className="text-sm text-slate-500 py-4 text-center">
              Loading alert inputs...
            </p>
          ) : alerts.length === 0 ? (
            <p className="text-sm text-emerald-600 py-4 text-center">
              No alerts. Your portfolio looks healthy.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Severity</TableHead>
                  <TableHead className="w-32">Type</TableHead>
                  <TableHead>System / Contract</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Badge
                        variant={
                          a.severity === "critical"
                            ? "destructive"
                            : a.severity === "warning"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {a.severity}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{a.type}</TableCell>
                    <TableCell className="font-medium text-sm">{a.system}</TableCell>
                    <TableCell className="text-sm text-slate-600">{a.message}</TableCell>
                    <TableCell className="text-sm text-slate-500">{a.action}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AskAiPanel
        moduleKey="solar-rec-alerts"
        title="Ask AI about active alerts"
        contextGetter={() => ({
          summary: alertSummary,
          alerts: alerts.map((a) => ({
            id: a.id,
            severity: a.severity,
            type: a.type,
            system: a.system,
            message: a.message,
            action: a.action,
          })),
        })}
      />
    </div>
  );
});
