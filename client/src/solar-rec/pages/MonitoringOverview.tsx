import { useMemo, useState } from "react";
import { solarRecTrpc as trpc } from "../solarRecTrpc";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Download, ArrowLeft } from "lucide-react";
import { PermissionGate } from "../components/PermissionGate";

// ── Helpers ─────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  return `${parts[1]}/${parts[2]}`;
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function getLast30Days(): { startDate: string; endDate: string; dateKeys: string[] } {
  const dates: string[] = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    dateKeys: dates,
  };
}

// ── Types ───────────────────────────────────────────────────────────

type ProviderGroup = {
  provider: string;
  totalSites: number;
  connections: ConnectionSummary[];
  dailyTotals: Map<string, { attempts: number; successes: number }>;
};

type ConnectionSummary = {
  connectionId: string;
  connectionName: string;
  siteCount: number;
  dailyStats: Map<string, { attempts: number; successes: number }>;
};

// ── Component ───────────────────────────────────────────────────────

export default function MonitoringOverview() {
  return (
    <PermissionGate moduleKey="monitoring-overview">
      <MonitoringOverviewImpl />
    </PermissionGate>
  );
}

function MonitoringOverviewImpl() {
  const { startDate, endDate, dateKeys } = useMemo(() => getLast30Days(), []);
  const [showLast7, setShowLast7] = useState(true);

  const overviewQuery = trpc.monitoring.getOverview.useQuery({
    startDate,
    endDate,
  });

  const visibleDates = useMemo(
    () => (showLast7 ? dateKeys.slice(-7) : dateKeys),
    [dateKeys, showLast7]
  );

  // Build the grouped data structure
  const providerGroups = useMemo<ProviderGroup[]>(() => {
    if (!overviewQuery.data) return [];

    const {
      daily,
      providerSiteCounts,
      connectionSiteCounts,
      credentials,
    } = overviewQuery.data;

    // Build credential name lookup
    const credNameMap = new Map<string, string>();
    for (const c of credentials) {
      credNameMap.set(c.id, c.name);
    }

    const providerMap = new Map<
      string,
      {
        connectionMap: Map<
          string,
          {
            siteCount: number;
            daily: Map<string, { attempts: number; successes: number }>;
          }
        >;
        totalSites: number;
        daily: Map<string, { attempts: number; successes: number }>;
      }
    >();

    const ensureProvider = (provider: string) => {
      if (!providerMap.has(provider)) {
        providerMap.set(provider, {
          connectionMap: new Map(),
          totalSites: 0,
          daily: new Map(),
        });
      }
      return providerMap.get(provider)!;
    };

    for (const row of providerSiteCounts) {
      ensureProvider(row.provider).totalSites = row.siteCount;
    }

    for (const row of connectionSiteCounts) {
      const pg = ensureProvider(row.provider);
      const connId = row.connectionId ?? "unknown";
      if (!pg.connectionMap.has(connId)) {
        pg.connectionMap.set(connId, {
          siteCount: row.siteCount,
          daily: new Map(),
        });
      }
      pg.connectionMap.get(connId)!.siteCount = row.siteCount;
    }

    for (const row of daily) {
      const provider = row.provider;
      const connId = row.connectionId ?? "unknown";
      const pg = ensureProvider(provider);

      const pd = pg.daily.get(row.dateKey) ?? { attempts: 0, successes: 0 };
      pd.attempts += row.attempts;
      pd.successes += row.successes;
      pg.daily.set(row.dateKey, pd);

      if (!pg.connectionMap.has(connId)) {
        pg.connectionMap.set(connId, {
          siteCount: 0,
          daily: new Map(),
        });
      }
      const conn = pg.connectionMap.get(connId)!;
      conn.daily.set(row.dateKey, {
        attempts: row.attempts,
        successes: row.successes,
      });
    }

    // Convert to sorted array
    return Array.from(providerMap.entries())
      .map(([provider, data]) => ({
        provider,
        totalSites: data.totalSites,
        dailyTotals: data.daily,
        connections: Array.from(data.connectionMap.entries())
          .map(([connId, connData]) => ({
            connectionId: connId,
            connectionName:
              connId === "unknown"
                ? "Unknown"
                : credNameMap.get(connId) ?? `...${connId.slice(-6)}`,
            siteCount: connData.siteCount,
            dailyStats: connData.daily,
          }))
          .sort((a, b) => b.siteCount - a.siteCount),
      }))
      .sort((a, b) => b.totalSites - a.totalSites);
  }, [overviewQuery.data]);

  // CSV export
  const handleExport = () => {
    const headers = [
      "provider",
      "connection",
      "sites",
      ...visibleDates.map((d) => `${d}_attempts`),
      ...visibleDates.map((d) => `${d}_successes`),
      ...visibleDates.map((d) => `${d}_pct`),
    ];
    const rows: string[][] = [];
    for (const pg of providerGroups) {
      // Provider aggregate row
      const pRow = [pg.provider, "(All)", String(pg.totalSites)];
      for (const d of visibleDates) {
        const s = pg.dailyTotals.get(d);
        pRow.push(String(s?.attempts ?? 0));
      }
      for (const d of visibleDates) {
        const s = pg.dailyTotals.get(d);
        pRow.push(String(s?.successes ?? 0));
      }
      for (const d of visibleDates) {
        const s = pg.dailyTotals.get(d);
        pRow.push(s ? pct(s.successes, s.attempts) : "");
      }
      rows.push(pRow);

      // Connection rows
      for (const conn of pg.connections) {
        const cRow = [pg.provider, conn.connectionName, String(conn.siteCount)];
        for (const d of visibleDates) {
          const s = conn.dailyStats.get(d);
          cRow.push(String(s?.attempts ?? 0));
        }
        for (const d of visibleDates) {
          const s = conn.dailyStats.get(d);
          cRow.push(String(s?.successes ?? 0));
        }
        for (const d of visibleDates) {
          const s = conn.dailyStats.get(d);
          cRow.push(s ? pct(s.successes, s.attempts) : "");
        }
        rows.push(cRow);
      }
    }

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `monitoring-overview-${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-[100vw] overflow-x-hidden">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => window.history.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1
            className="text-2xl font-bold tracking-wide uppercase text-foreground"
            style={{ fontFamily: '"Permanent Marker", cursive' }}
          >
            Monitoring Overview
          </h1>
          <p className="text-sm text-muted-foreground">
            Daily success breakdown by provider and API key/login
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={showLast7 ? "default" : "outline"}
            size="sm"
            onClick={() => setShowLast7(true)}
          >
            7 Days
          </Button>
          <Button
            variant={!showLast7 ? "default" : "outline"}
            size="sm"
            onClick={() => setShowLast7(false)}
          >
            30 Days
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="h-3 w-3 mr-1" />
            Export
          </Button>
        </div>
      </div>

      {overviewQuery.isLoading && (
        <p className="text-sm text-muted-foreground text-center py-12">
          Loading monitoring data...
        </p>
      )}

      {/* Provider Cards */}
      {providerGroups.map((pg) => (
        <Card key={pg.provider}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">{pg.provider}</CardTitle>
                <CardDescription>
                  {pg.totalSites} sites across {pg.connections.length} connection
                  {pg.connections.length !== 1 ? "s" : ""}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* Provider aggregate row */}
            <div className="mb-3 rounded-md border p-2 bg-muted/30">
              <p className="text-xs font-bold uppercase tracking-wider mb-2">
                Aggregate — {pg.totalSites} Sites
              </p>
              <div className="flex gap-1 overflow-x-auto">
                {visibleDates.map((dateKey) => {
                  const s = pg.dailyTotals.get(dateKey);
                  const attempts = s?.attempts ?? 0;
                  const successes = s?.successes ?? 0;
                  const rate = attempts > 0 ? successes / attempts : 0;
                  return (
                    <div
                      key={dateKey}
                      className="flex flex-col items-center min-w-[48px] text-center"
                    >
                      <span className="text-[9px] text-muted-foreground">
                        {formatDate(dateKey)}
                      </span>
                      <span
                        className={`text-xs font-bold ${
                          attempts === 0
                            ? "text-muted-foreground"
                            : rate >= 0.9
                              ? "text-emerald-600 dark:text-emerald-400"
                              : rate >= 0.7
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-red-600 dark:text-red-400"
                        }`}
                      >
                        {attempts === 0 ? "—" : `${successes}/${attempts}`}
                      </span>
                      {attempts > 0 && (
                        <Badge
                          variant="outline"
                          className={`text-[9px] px-1 py-0 ${
                            rate >= 0.9
                              ? "text-emerald-700 border-emerald-300 dark:text-emerald-400 dark:border-emerald-700"
                              : rate >= 0.7
                                ? "text-amber-700 border-amber-300 dark:text-amber-400 dark:border-amber-700"
                                : "text-red-700 border-red-300 dark:text-red-400 dark:border-red-700"
                          }`}
                        >
                          {pct(successes, attempts)}
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Connection breakdown table */}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 bg-card z-10 min-w-[160px]">
                      Connection
                    </TableHead>
                    <TableHead className="text-right min-w-[50px]">Sites</TableHead>
                    {visibleDates.map((d) => (
                      <TableHead key={d} className="text-center text-[10px] min-w-[52px]">
                        {formatDate(d)}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pg.connections.map((conn) => (
                    <TableRow key={conn.connectionId}>
                      <TableCell className="sticky left-0 bg-card z-10 font-medium text-xs truncate max-w-[180px]">
                        {conn.connectionName}
                      </TableCell>
                      <TableCell className="text-right text-xs">{conn.siteCount}</TableCell>
                      {visibleDates.map((dateKey) => {
                        const s = conn.dailyStats.get(dateKey);
                        const attempts = s?.attempts ?? 0;
                        const successes = s?.successes ?? 0;
                        const rate = attempts > 0 ? successes / attempts : 0;
                        return (
                          <TableCell key={dateKey} className="text-center text-[10px] p-1">
                            {attempts === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span
                                className={`font-medium ${
                                  rate >= 0.9
                                    ? "text-emerald-600 dark:text-emerald-400"
                                    : rate >= 0.7
                                      ? "text-amber-600 dark:text-amber-400"
                                      : "text-red-600 dark:text-red-400"
                                }`}
                              >
                                {successes}/{attempts}
                              </span>
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
