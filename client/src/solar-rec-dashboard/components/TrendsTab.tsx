/**
 * Trends tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 7 of the
 * god-component decomposition — first of four "easy isolated tabs" in
 * one shipping batch. Owns:
 *   - 3 useMemos (trendDeliveryPace, trendProductionMoM, trendTopSiteIds)
 *
 * `trendDeliveryPace` is computed via `buildTrendDeliveryPace` from
 * `lib/helpers/trends.ts` — the same pure helper the AlertsTab calls
 * to detect delivery pace alerts.
 */

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buildTrendDeliveryPace } from "@/solar-rec-dashboard/lib/helpers";
import type { CsvDataset } from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Minimal log entry fields the reporting-rate-over-time chart needs.
 * The full `DashboardLogEntry` type in the parent is much wider but
 * structural typing means an array of full log entries assigns
 * cleanly to this prop.
 */
export type TrendsLogEntry = {
  createdAt: Date;
  reportingPercent: number | null;
  totalSystems: number;
};

export interface TrendsTabProps {
  /** Converted reads CSV — drives the month-over-month production chart. */
  convertedReads: CsvDataset | null;
  /** Schedule B base CSV — drives the delivery pace chart. */
  deliveryScheduleBase: CsvDataset | null;
  /** GATS transfer lookup, for the delivery pace chart. */
  transferDeliveryLookup: Map<string, Map<number, number>>;
  /** Dashboard snapshots, for the reporting-rate-over-time chart. */
  logEntries: TrendsLogEntry[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TrendsTab(props: TrendsTabProps) {
  const { convertedReads, deliveryScheduleBase, transferDeliveryLookup, logEntries } =
    props;

  // -------------------------------------------------------------------------
  // Delivery pace: computed via the shared helper so the alerts tab can
  // call it independently with the same inputs.
  // -------------------------------------------------------------------------
  const trendDeliveryPace = useMemo(
    () =>
      buildTrendDeliveryPace(
        deliveryScheduleBase?.rows ?? [],
        transferDeliveryLookup,
      ),
    [deliveryScheduleBase, transferDeliveryLookup],
  );

  // -------------------------------------------------------------------------
  // Month-over-month production for the top 10 sites by total output
  // -------------------------------------------------------------------------
  const trendProductionMoM = useMemo(() => {
    const rows = convertedReads?.rows ?? [];
    if (rows.length === 0) return [];

    // Group by system_id + month
    const siteMonths = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const sysId = row.monitoring_system_id || row.monitoring_system_name || "";
      if (!sysId) continue;
      const rawWh = parseFloat(row.lifetime_meter_read_wh || "");
      if (!Number.isFinite(rawWh)) continue;
      const readDate = row.read_date || "";
      if (!readDate) continue;
      // Parse M/D/YYYY or YYYY-MM-DD
      const d = new Date(readDate);
      if (isNaN(d.getTime())) continue;
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

      if (!siteMonths.has(sysId)) siteMonths.set(sysId, new Map());
      const months = siteMonths.get(sysId)!;
      // Keep the max lifetime read per month
      const existing = months.get(monthKey) ?? 0;
      if (rawWh > existing) months.set(monthKey, rawWh);
    }

    // Calculate deltas
    type SiteTrend = { siteId: string; months: { month: string; deltaKwh: number }[] };
    const siteTrends: SiteTrend[] = [];

    siteMonths.forEach((months, siteId) => {
      const sorted = Array.from(months.entries()).sort((a, b) =>
        a[0].localeCompare(b[0]),
      );
      const deltas: { month: string; deltaKwh: number }[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const delta = (sorted[i][1] - sorted[i - 1][1]) / 1000; // Wh to kWh
        if (delta > 0)
          deltas.push({ month: sorted[i][0], deltaKwh: Math.round(delta) });
      }
      if (deltas.length > 0) siteTrends.push({ siteId, months: deltas });
    });

    // Get all months across all sites
    const allMonths = Array.from(
      new Set(siteTrends.flatMap((s) => s.months.map((m) => m.month))),
    ).sort();

    // Top 10 sites by total production
    const sorted = siteTrends
      .map((s) => ({
        ...s,
        total: s.months.reduce((a, m) => a + m.deltaKwh, 0),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    // Build chart data: each row is a month, each column is a site
    return allMonths.map((month) => {
      const point: Record<string, string | number> = { month };
      for (const site of sorted) {
        const m = site.months.find((mm) => mm.month === month);
        point[site.siteId] = m?.deltaKwh ?? 0;
      }
      return point;
    });
  }, [convertedReads]);

  const trendTopSiteIds = useMemo(() => {
    if (trendProductionMoM.length === 0) return [];
    const first = trendProductionMoM[0];
    return Object.keys(first)
      .filter((k) => k !== "month")
      .slice(0, 10);
  }, [trendProductionMoM]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delivery Pace by Contract</CardTitle>
          <CardDescription>
            Expected pace (based on time elapsed) vs actual delivery pace for active
            contracts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {trendDeliveryPace.length === 0 ? (
            <p className="text-sm text-slate-500 py-4 text-center">
              Scrape Schedule B PDFs in the Delivery Tracker tab and upload Transfer
              History to see delivery pace.
            </p>
          ) : (
            <div className="h-72 rounded-md border border-slate-200 bg-white p-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={trendDeliveryPace}
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
                  <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} unit="%" />
                  <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                  <Legend />
                  <Bar dataKey="expectedPace" fill="#94a3b8" name="Expected Pace %" />
                  <Bar dataKey="actualPace" fill="#16a34a" name="Actual Pace %" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Month-over-Month Production (Top 10 Sites)
          </CardTitle>
          <CardDescription>
            Monthly production deltas (kWh) from converted reads, showing top 10 sites by
            total output.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {trendProductionMoM.length === 0 ? (
            <p className="text-sm text-slate-500 py-4 text-center">
              Upload Converted Reads to see production trends.
            </p>
          ) : (
            <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={trendProductionMoM}
                  margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Legend />
                  {trendTopSiteIds.map((siteId, i) => (
                    <Line
                      key={siteId}
                      type="monotone"
                      dataKey={siteId}
                      stroke={
                        [
                          "#16a34a",
                          "#0ea5e9",
                          "#f59e0b",
                          "#ef4444",
                          "#8b5cf6",
                          "#ec4899",
                          "#14b8a6",
                          "#f97316",
                          "#6366f1",
                          "#84cc16",
                        ][i % 10]
                      }
                      name={siteId.length > 25 ? siteId.slice(0, 22) + "..." : siteId}
                      dot={false}
                      strokeWidth={2}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reporting Rate Over Time</CardTitle>
          <CardDescription>
            Historical reporting percentage from dashboard snapshots.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {logEntries.length < 2 ? (
            <p className="text-sm text-slate-500 py-4 text-center">
              Take at least 2 snapshots to see reporting rate trends.
            </p>
          ) : (
            <div className="h-64 rounded-md border border-slate-200 bg-white p-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={logEntries
                    .slice()
                    .reverse()
                    .map((e) => ({
                      date: e.createdAt.toLocaleDateString(),
                      reportingPercent: e.reportingPercent ?? 0,
                      totalSystems: e.totalSystems,
                    }))}
                  margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} unit="%" />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="reportingPercent"
                    stroke="#16a34a"
                    name="Reporting %"
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
