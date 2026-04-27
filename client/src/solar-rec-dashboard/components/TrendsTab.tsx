/**
 * Trends tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 7 of the
 * god-component decomposition. Originally owned 3 useMemos (delivery
 * pace, production MoM, top site IDs) all reading raw row arrays
 * from datasets. After Task 5.13, all three are server-aggregated:
 * delivery-pace via `getDashboardTrendDeliveryPace` (PR-2),
 * production-MoM + top-site-IDs via `getDashboardTrendsProduction`
 * (PR-4). This tab now reads zero `datasets[k].rows` arrays.
 */

import { memo } from "react";
import { AskAiPanel } from "@/components/AskAiPanel";
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
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";

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
  /** Dashboard snapshots, for the reporting-rate-over-time chart. */
  logEntries: TrendsLogEntry[];
  /**
   * Whether this tab is currently active. Gates the two server
   * queries (delivery pace + monthly production) so neither
   * roundtrip fires unless the user is actually viewing trends.
   */
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function TrendsTab(props: TrendsTabProps) {
  const { logEntries, isActive } = props;

  // Task 5.13 PR-2: server-side delivery-pace aggregate (shared with
  // AlertsTab). Same shape + values as the original
  // `buildTrendDeliveryPace(deliveryScheduleBase.rows, transferDelivery
  // Lookup)` useMemo.
  const trendDeliveryPaceQuery =
    solarRecTrpc.solarRecDashboard.getDashboardTrendDeliveryPace.useQuery(
      undefined,
      {
        enabled: isActive,
        staleTime: 60_000,
      }
    );
  const trendDeliveryPace = trendDeliveryPaceQuery.data?.rows ?? [];

  // Task 5.13 PR-4: server-side production aggregate. Replaces the
  // pair of useMemos (`trendProductionMoM` + `trendTopSiteIds`) that
  // iterated `convertedReads.rows` to build the month-over-month
  // top-10-sites chart. The server reads `srDsConvertedReads`
  // directly, runs the same MAX-per-(site,month) → delta → top-10
  // sort, and returns both the chart rows and the legend-order site
  // IDs in one payload.
  const trendsProductionQuery =
    solarRecTrpc.solarRecDashboard.getDashboardTrendsProduction.useQuery(
      undefined,
      {
        enabled: isActive,
        staleTime: 60_000,
      }
    );
  const trendProductionMoM = trendsProductionQuery.data?.chartRows ?? [];
  const trendTopSiteIds = trendsProductionQuery.data?.topSiteIds ?? [];

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

      <AskAiPanel
        moduleKey="solar-rec-trends"
        title="Ask AI about trends"
        contextGetter={() => ({
          deliveryPace: {
            points: trendDeliveryPace.length,
            recent12: trendDeliveryPace.slice(-12),
          },
          productionMoM: {
            monthsCovered: trendProductionMoM.length,
            topSiteIds: trendTopSiteIds,
            recent12: trendProductionMoM.slice(-12),
          },
          reportingLogEntries: logEntries.length,
          latestLogEntries: logEntries.slice(-12).map((e) => ({
            createdAt: e.createdAt
              ? e.createdAt.toISOString().slice(0, 10)
              : null,
            totalSystems: e.totalSystems,
            reportingPercent: e.reportingPercent,
          })),
        })}
      />
    </div>
  );
});
