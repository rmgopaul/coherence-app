/**
 * Comparisons tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 7 of the
 * god-component decomposition. Now reads the derived
 * `getDashboardSystemsPage` fact table directly instead of receiving
 * the parent legacy all-systems snapshot. Owns:
 *   - 2 useMemos (comparisonInstallers, comparisonPlatforms)
 *   - 2 charts + 2 tables comparing reporting + delivery rates by
 *     installer and by monitoring platform
 */

import { memo, useCallback, useEffect, useMemo } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { AskAiPanel } from "@/components/AskAiPanel";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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
import {
  formatNumber,
  toPercentValue,
} from "@/solar-rec-dashboard/lib/helpers";
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
import { useDashboardBuildControl } from "@/solar-rec-dashboard/hooks/useDashboardBuildControl";
import type { SolarRecAppRouter } from "@server/_core/solarRecRouter";

// ---------------------------------------------------------------------------
// Types/constants
// ---------------------------------------------------------------------------

type RouterOutputs = inferRouterOutputs<SolarRecAppRouter>;
type SystemsPageOutput =
  RouterOutputs["solarRecDashboard"]["getDashboardSystemsPage"];
type SystemsPageRow = SystemsPageOutput["rows"][number];

const SYSTEMS_PAGE_SIZE = 500;

export interface ComparisonsTabProps {
  isActive: boolean;
}

function parseDecimalString(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function ComparisonsTab(props: ComparisonsTabProps) {
  const { isActive } = props;
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

  const comparisonInstallers = useMemo(() => {
    const groups = new Map<
      string,
      {
        name: string;
        total: number;
        reporting: number;
        totalValue: number;
        deliveredValue: number;
      }
    >();

    systemRows.forEach((sys) => {
      const name = sys.installerName || "Unknown";
      const g = groups.get(name) ?? {
        name,
        total: 0,
        reporting: 0,
        totalValue: 0,
        deliveredValue: 0,
      };
      g.total += 1;
      if (sys.isReporting) g.reporting += 1;
      g.totalValue += parseDecimalString(sys.contractedValue) ?? 0;
      g.deliveredValue += parseDecimalString(sys.deliveredValue) ?? 0;
      groups.set(name, g);
    });

    return Array.from(groups.values())
      .map((g) => ({
        ...g,
        reportingPercent: toPercentValue(g.reporting, g.total),
        deliveryPercent: toPercentValue(g.deliveredValue, g.totalValue),
      }))
      .sort((a, b) => b.total - a.total);
  }, [systemRows]);

  const comparisonPlatforms = useMemo(() => {
    const groups = new Map<
      string,
      {
        name: string;
        total: number;
        reporting: number;
        offline: number;
        offlineValue: number;
      }
    >();

    systemRows.forEach((sys) => {
      const name = sys.monitoringPlatform || "Unknown";
      const g = groups.get(name) ?? {
        name,
        total: 0,
        reporting: 0,
        offline: 0,
        offlineValue: 0,
      };
      g.total += 1;
      if (sys.isReporting) {
        g.reporting += 1;
      } else {
        g.offline += 1;
        g.offlineValue += parseDecimalString(sys.contractedValue) ?? 0;
      }
      groups.set(name, g);
    });

    return Array.from(groups.values())
      .map((g) => ({
        ...g,
        reportingPercent: toPercentValue(g.reporting, g.total),
        offlinePercent: toPercentValue(g.offline, g.total),
      }))
      .sort((a, b) => b.total - a.total);
  }, [systemRows]);

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
          <div className="text-slate-700">
            Loaded {formatNumber(systemRows.length)} systems
            {hasLoadedAllRows ? "" : " so far"} for comparison.
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

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Installer Performance</CardTitle>
              <CardDescription>
                Systems grouped by installer with reporting rate and delivery metrics.
              </CardDescription>
            </div>
            {comparisonInstallers.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const csv = buildCsv(
                    [
                      "installer",
                      "total_systems",
                      "reporting",
                      "reporting_percent",
                      "total_value",
                      "delivered_value",
                      "delivery_percent",
                    ],
                    comparisonInstallers.map((i) => ({
                      installer: i.name,
                      total_systems: i.total,
                      reporting: i.reporting,
                      reporting_percent:
                        i.reportingPercent !== null ? i.reportingPercent.toFixed(1) : "",
                      total_value: i.totalValue,
                      delivered_value: i.deliveredValue,
                      delivery_percent:
                        i.deliveryPercent !== null ? i.deliveryPercent.toFixed(1) : "",
                    })),
                  );
                  triggerCsvDownload(
                    `installer-performance-${timestampForCsvFileName()}.csv`,
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
          {comparisonInstallers.length === 0 ? (
            <p className="text-sm text-slate-500 py-4 text-center">
              No system data available.
            </p>
          ) : (
            <>
              <div className="h-64 rounded-md border border-slate-200 bg-white p-2 mb-4">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={comparisonInstallers.slice(0, 15)}
                    margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 10 }}
                      angle={-35}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} unit="%" />
                    <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                    <Bar dataKey="reportingPercent" fill="#16a34a" name="Reporting %" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Installer</TableHead>
                    <TableHead className="text-right">Systems</TableHead>
                    <TableHead className="text-right">Reporting</TableHead>
                    <TableHead className="text-right">Reporting %</TableHead>
                    <TableHead className="text-right">Contract Value</TableHead>
                    <TableHead className="text-right">Delivery %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {comparisonInstallers.map((i) => (
                    <TableRow key={i.name}>
                      <TableCell className="font-medium">{i.name}</TableCell>
                      <TableCell className="text-right">{i.total}</TableCell>
                      <TableCell className="text-right">{i.reporting}</TableCell>
                      <TableCell className="text-right">
                        {i.reportingPercent !== null
                          ? `${i.reportingPercent.toFixed(1)}%`
                          : "N/A"}
                      </TableCell>
                      <TableCell className="text-right">
                        ${formatNumber(i.totalValue)}
                      </TableCell>
                      <TableCell className="text-right">
                        {i.deliveryPercent !== null
                          ? `${i.deliveryPercent.toFixed(1)}%`
                          : "N/A"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Monitoring Platform Reliability</CardTitle>
              <CardDescription>
                Reporting rate and offline metrics by monitoring platform.
              </CardDescription>
            </div>
            {comparisonPlatforms.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const csv = buildCsv(
                    [
                      "platform",
                      "total_systems",
                      "reporting",
                      "reporting_percent",
                      "offline",
                      "offline_value",
                    ],
                    comparisonPlatforms.map((p) => ({
                      platform: p.name,
                      total_systems: p.total,
                      reporting: p.reporting,
                      reporting_percent:
                        p.reportingPercent !== null ? p.reportingPercent.toFixed(1) : "",
                      offline: p.offline,
                      offline_value: p.offlineValue,
                    })),
                  );
                  triggerCsvDownload(
                    `platform-reliability-${timestampForCsvFileName()}.csv`,
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
          {comparisonPlatforms.length === 0 ? (
            <p className="text-sm text-slate-500 py-4 text-center">
              No system data available.
            </p>
          ) : (
            <>
              <div className="h-64 rounded-md border border-slate-200 bg-white p-2 mb-4">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={comparisonPlatforms.slice(0, 15)}
                    margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 10 }}
                      angle={-35}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} unit="%" />
                    <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                    <Bar dataKey="reportingPercent" fill="#0ea5e9" name="Reporting %" />
                    <Bar dataKey="offlinePercent" fill="#ef4444" name="Offline %" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Platform</TableHead>
                    <TableHead className="text-right">Systems</TableHead>
                    <TableHead className="text-right">Reporting</TableHead>
                    <TableHead className="text-right">Reporting %</TableHead>
                    <TableHead className="text-right">Offline</TableHead>
                    <TableHead className="text-right">Offline Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {comparisonPlatforms.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell className="text-right">{p.total}</TableCell>
                      <TableCell className="text-right">{p.reporting}</TableCell>
                      <TableCell className="text-right">
                        {p.reportingPercent !== null
                          ? `${p.reportingPercent.toFixed(1)}%`
                          : "N/A"}
                      </TableCell>
                      <TableCell className="text-right">{p.offline}</TableCell>
                      <TableCell className="text-right">
                        ${formatNumber(p.offlineValue)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <AskAiPanel
        moduleKey="solar-rec-comparisons"
        title="Ask AI about installer + platform comparisons"
        contextGetter={() => ({
          totals: { systems: systemRows.length },
          installers: comparisonInstallers.slice(0, 30),
          platforms: comparisonPlatforms.slice(0, 30),
        })}
      />
    </div>
  );
});
