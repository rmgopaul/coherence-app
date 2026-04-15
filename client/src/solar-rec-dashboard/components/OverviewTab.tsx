/**
 * Overview tab.
 *
 * Extracted from SolarRecDashboard.tsx. Phase 8. Pure reader component:
 * it holds no state of its own and doesn't define any useMemos. All
 * data comes in via props because other tabs (Size, REC Value,
 * ChangeOwnershipTab, OverviewTab, Financials, AI context builder,
 * createLogEntry, ...) also read most of these memos.
 *
 * The only thing this component "does" is render ~240 lines of JSX
 * with the parent-computed data: 3 rows of KPI tiles, 2 charts
 * (reporting-by-size + ownership-mix), and a big clickable
 * ownership-counts grid with export callbacks.
 */

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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatCurrency, formatPercent } from "@/lib/helpers";
import {
  formatCapacityKw,
  formatNumber,
} from "@/solar-rec-dashboard/lib/helpers";
import type {
  ChangeOwnershipStatus,
  ChangeOwnershipSummary,
  FinancialProfitData,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Minimal structural shape of the parent `summary` memo. The full
 * object has more fields but the Overview JSX only reads these.
 * Structural typing means passing the full summary still satisfies
 * this prop.
 */
export type OverviewSummary = {
  totalSystems: number;
  reportingSystems: number;
  reportingPercent: number | null;
  smallSystems: number;
  largeSystems: number;
  ownershipOverview: {
    reportingOwnershipTotal: number;
    notReportingOwnershipTotal: number;
    terminatedTotal: number;
  };
};

export type OverviewPart2Totals = {
  totalContractedValuePart2: number;
  cumulativeKwAcPart2: number;
  cumulativeKwDcPart2: number;
};

export type OverviewSizeChartRow = {
  bucket: string;
  reporting: number;
  notReporting: number;
};

export type OverviewOwnershipChartRow = {
  label: string;
  notTransferred: number;
  transferred: number;
  changeOwnership: number;
};

export interface OverviewTabProps {
  summary: OverviewSummary;
  overviewPart2Totals: OverviewPart2Totals;
  financialProfitData: FinancialProfitData;
  sizeReportingChartRows: OverviewSizeChartRow[];
  ownershipStackedChartRows: OverviewOwnershipChartRow[];
  changeOwnershipSummary: ChangeOwnershipSummary;
  onDownloadOwnershipTile: (tile: "reporting" | "notReporting" | "terminated") => void;
  onDownloadChangeOwnershipTile: (status: ChangeOwnershipStatus) => void;
  onJumpToOfflineMonitoring: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OverviewTab(props: OverviewTabProps) {
  const {
    summary,
    overviewPart2Totals,
    financialProfitData,
    sizeReportingChartRows,
    ownershipStackedChartRows,
    changeOwnershipSummary,
    onDownloadOwnershipTile,
    onDownloadChangeOwnershipTile,
    onJumpToOfflineMonitoring,
  } = props;

  const findCount = (status: ChangeOwnershipStatus) =>
    changeOwnershipSummary.counts.find((item) => item.status === status)?.count ?? 0;

  return (
    <div className="space-y-4 mt-4">
      {/* Row 1: System counts — compact, short values */}
      <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Total Systems</CardDescription>
            <CardTitle className="text-2xl">{formatNumber(summary.totalSystems)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Reporting in Last 3 Months</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(summary.reportingSystems)}
            </CardTitle>
            <CardDescription>{formatPercent(summary.reportingPercent)}</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>{`<=10 kW AC`}</CardDescription>
            <CardTitle className="text-2xl">{formatNumber(summary.smallSystems)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>{`>10 kW AC`}</CardDescription>
            <CardTitle className="text-2xl">{formatNumber(summary.largeSystems)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Row 2: Part II verified values — wider cards for long numbers */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Total Contracted Value (Part II Verified)</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(overviewPart2Totals.totalContractedValuePart2)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Cumulative kW AC (Part II Verified)</CardDescription>
            <CardTitle className="text-2xl">
              {formatCapacityKw(overviewPart2Totals.cumulativeKwAcPart2)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Cumulative kW DC (Part II Verified)</CardDescription>
            <CardTitle className="text-2xl">
              {formatCapacityKw(overviewPart2Totals.cumulativeKwDcPart2)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Row 3: Financial totals from Profit & Collateralization */}
      <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Total Vendor Fee</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(financialProfitData.totalProfit)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Total Utility Collateral</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(financialProfitData.totalUtilityCollateral)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Total Additional Collateral</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(financialProfitData.totalAdditionalCollateral)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Total CC Auth Collateral</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(financialProfitData.totalCcAuth)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reporting by Size Bucket</CardTitle>
            <CardDescription>Stacked reporting vs not reporting counts.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72 rounded-md border border-slate-200 bg-white p-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={sizeReportingChartRows}
                  margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Legend />
                  <Bar
                    dataKey="reporting"
                    stackId="size-status"
                    fill="#16a34a"
                    name="Reporting"
                  />
                  <Bar
                    dataKey="notReporting"
                    stackId="size-status"
                    fill="#f59e0b"
                    name="Not Reporting"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ownership Mix by Reporting State</CardTitle>
            <CardDescription>
              Part II verified, non-terminated systems split into Not Transferred,
              Transferred, and Change of Ownership.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72 rounded-md border border-slate-200 bg-white p-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={ownershipStackedChartRows}
                  margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Legend />
                  <Bar
                    dataKey="notTransferred"
                    stackId="ownership"
                    fill="#0ea5e9"
                    name="Not Transferred"
                  />
                  <Bar
                    dataKey="transferred"
                    stackId="ownership"
                    fill="#8b5cf6"
                    name="Transferred"
                  />
                  <Bar
                    dataKey="changeOwnership"
                    stackId="ownership"
                    fill="#f97316"
                    name="Change of Ownership"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ownership and Reporting Status Counts</CardTitle>
          <CardDescription>
            Part II verified systems only. Click any tile to export matching systems to CSV.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <button
              type="button"
              onClick={() => onDownloadOwnershipTile("reporting")}
              className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            >
              <p className="text-xs font-semibold text-emerald-800">Reporting</p>
              <p className="text-2xl font-semibold text-emerald-900">
                {formatNumber(summary.ownershipOverview.reportingOwnershipTotal)}
              </p>
            </button>
            <button
              type="button"
              onClick={onJumpToOfflineMonitoring}
              title="View offline systems"
              className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
            >
              <p className="text-xs font-semibold text-amber-800">Not Reporting</p>
              <p className="text-2xl font-semibold text-amber-900">
                {formatNumber(summary.ownershipOverview.notReportingOwnershipTotal)}
              </p>
              <p className="text-[10px] text-amber-600 mt-1">Click to view offline systems</p>
            </button>
            <button
              type="button"
              onClick={() => onDownloadOwnershipTile("terminated")}
              className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
            >
              <p className="text-xs font-semibold text-slate-700">Terminated</p>
              <p className="text-2xl font-semibold text-slate-900">
                {formatNumber(summary.ownershipOverview.terminatedTotal)}
              </p>
            </button>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Change of Ownership
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <button
              type="button"
              onClick={() => onDownloadChangeOwnershipTile("Transferred and Reporting")}
              className="rounded-lg border border-emerald-300 bg-emerald-100 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            >
              <p className="text-xs font-semibold text-emerald-900">
                Ownership Changed, Transferred and Reporting
              </p>
              <p className="text-2xl font-semibold text-emerald-950">
                {formatNumber(findCount("Transferred and Reporting"))}
              </p>
            </button>
            <button
              type="button"
              onClick={() =>
                onDownloadChangeOwnershipTile(
                  "Change of Ownership - Not Transferred and Reporting",
                )
              }
              className="rounded-lg border border-green-200 bg-green-50 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2"
            >
              <p className="text-xs font-semibold text-green-800">
                Change of Ownership - Not Transferred and Reporting
              </p>
              <p className="text-2xl font-semibold text-green-900">
                {formatNumber(
                  findCount("Change of Ownership - Not Transferred and Reporting"),
                )}
              </p>
            </button>
            <button
              type="button"
              onClick={() =>
                onDownloadChangeOwnershipTile("Transferred and Not Reporting")
              }
              className="rounded-lg border border-amber-300 bg-amber-100 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
            >
              <p className="text-xs font-semibold text-amber-800">
                Ownership Changed, Transferred but not Reporting
              </p>
              <p className="text-2xl font-semibold text-amber-900">
                {formatNumber(findCount("Transferred and Not Reporting"))}
              </p>
            </button>
            <button
              type="button"
              onClick={() =>
                onDownloadChangeOwnershipTile(
                  "Change of Ownership - Not Transferred and Not Reporting",
                )
              }
              className="rounded-lg border border-rose-300 bg-rose-100 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2"
            >
              <p className="text-xs font-semibold text-rose-800">
                Ownership Changed, but not Transferred and not Reporting
              </p>
              <p className="text-2xl font-semibold text-rose-900">
                {formatNumber(
                  findCount("Change of Ownership - Not Transferred and Not Reporting"),
                )}
              </p>
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
