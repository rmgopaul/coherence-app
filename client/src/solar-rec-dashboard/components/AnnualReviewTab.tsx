/**
 * Annual REC Review tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 6 of the
 * god-component decomposition — second slice of the REC performance
 * spine (after ContractsTab). Owns:
 *   - 2 useStates (annualContractVintagePage, annualContractSummaryPage)
 *   - 6 useMemos (annualContractVintageRows, annualVintageRows,
 *     annualContractSummaryRows, annualPortfolioSummary,
 *     visibleAnnualContractVintageRows, visibleAnnualContractSummaryRows,
 *     annualVintageTrendChartRows)
 *   - ~380 lines of JSX (6 KPI cards, vintage trend chart, vintage table,
 *     contract+vintage detail table, contract totals table)
 *
 * Receives the same four spine foundation lookups as ContractsTab as
 * props from the parent. Uses `systemsByTrackingId` to count reporting
 * projects per (contract, vintage) — the only extra dependency vs
 * ContractsTab.
 */

import { memo, useMemo, useState } from "react";
import { AskAiPanel } from "@/components/AskAiPanel";
import { toDateKey } from "@shared/dateKey";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency, formatPercent } from "@/lib/helpers";
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
  formatDate,
  formatNumber,
  toPercentValue,
} from "@/solar-rec-dashboard/lib/helpers";
import {
  ANNUAL_CONTRACT_SUMMARY_PAGE_SIZE,
  ANNUAL_CONTRACT_VINTAGE_PAGE_SIZE,
} from "@/solar-rec-dashboard/lib/constants";
import type {
  AnnualContractVintageAggregate,
  AnnualVintageAggregate,
} from "@/solar-rec-dashboard/state/types";
// Task 5.13 PR-3 (2026-04-27): annualContractVintageRows moved
// server-side, shared with ContractsTab. AnnualReviewTab now reads
// the aggregate via tRPC and applies its own
// (deliveryStartDate, contractId) sort locally. With this PR,
// AnnualReviewTab no longer reads any raw `datasets[k].rows` arrays.
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AnnualReviewTabProps {
  /**
   * Whether this tab is currently active. Gates the
   * `getDashboardContractVintageAggregates` query so the network
   * roundtrip only fires when the user is actually viewing annual
   * review.
   */
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function AnnualReviewTab(props: AnnualReviewTabProps) {
  const { isActive } = props;

  const [annualContractVintagePage, setAnnualContractVintagePage] = useState(1);
  const [annualContractSummaryPage, setAnnualContractSummaryPage] = useState(1);

  // Task 5.13 PR-3: server-side aggregate (shared with ContractsTab).
  // The Annual Review consumes the same per-(contract, deliveryStartDate)
  // detail rows ContractsTab does, plus the `reportingProjectCount`
  // field that the server-side aggregator computes from the system
  // snapshot's `isReporting` flag. Both tabs hit the same
  // `getDashboardContractVintageAggregates` query.
  const contractVintageQuery =
    solarRecTrpc.solarRecDashboard.getDashboardContractVintageAggregates.useQuery(
      undefined,
      {
        enabled: isActive,
        staleTime: 60_000,
      }
    );

  // -------------------------------------------------------------------------
  // Per (contractId, deliveryStartDate) aggregation. Same shape as the
  // Contracts tab's `contractDeliveryRows` but with reportingProject
  // counts so the annual review can show what % of each vintage's
  // projects are still reporting.
  // -------------------------------------------------------------------------
  // Server returns the union-of-fields aggregate; AnnualReviewTab
  // reads `reportingProjectCount` + `reportingProjectPercent`
  // (computed server-side from the system snapshot's `isReporting`
  // flag). The extra `pricedProjectCount` field that the server
  // includes for ContractsTab is benign here.
  // Sort by (deliveryStartDate, contractId) — annual-review's
  // chronological view; ContractsTab applies its own
  // (contractId, deliveryStartDate) sort.
  const annualContractVintageRows = useMemo<AnnualContractVintageAggregate[]>(
    () => {
      const rows = contractVintageQuery.data?.rows ?? [];
      return [...rows].sort((a, b) => {
        const aTime = a.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        const bTime = b.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        if (aTime !== bTime) return aTime - bTime;
        return a.contractId.localeCompare(b.contractId);
      });
    },
    [contractVintageQuery.data]
  );

  // -------------------------------------------------------------------------
  // Roll up per (contractId, vintage) → per vintage (across all contracts)
  // -------------------------------------------------------------------------
  const annualVintageRows = useMemo<AnnualVintageAggregate[]>(() => {
    const groups = new Map<
      string,
      {
        deliveryStartDate: Date | null;
        deliveryStartRaw: string;
        required: number;
        delivered: number;
        requiredValue: number;
        deliveredValue: number;
        projectCount: number;
        reportingProjectCount: number;
      }
    >();

    annualContractVintageRows.forEach((row) => {
      const dateKey = row.deliveryStartDate
        ? toDateKey(row.deliveryStartDate)
        : row.deliveryStartRaw;
      let current = groups.get(dateKey);
      if (!current) {
        current = {
          deliveryStartDate: row.deliveryStartDate,
          deliveryStartRaw: row.deliveryStartRaw,
          required: 0,
          delivered: 0,
          requiredValue: 0,
          deliveredValue: 0,
          projectCount: 0,
          reportingProjectCount: 0,
        };
        groups.set(dateKey, current);
      }

      current.required += row.required;
      current.delivered += row.delivered;
      current.requiredValue += row.requiredValue;
      current.deliveredValue += row.deliveredValue;
      current.projectCount += row.projectCount;
      current.reportingProjectCount += row.reportingProjectCount;
    });

    return Array.from(groups.values())
      .map((group) => ({
        deliveryStartDate: group.deliveryStartDate,
        deliveryStartRaw: group.deliveryStartRaw,
        label: group.deliveryStartDate
          ? formatDate(group.deliveryStartDate)
          : group.deliveryStartRaw,
        projectCount: group.projectCount,
        reportingProjectCount: group.reportingProjectCount,
        reportingProjectPercent: toPercentValue(
          group.reportingProjectCount,
          group.projectCount,
        ),
        required: group.required,
        delivered: group.delivered,
        gap: group.required - group.delivered,
        deliveredPercent: toPercentValue(group.delivered, group.required),
        requiredValue: group.requiredValue,
        deliveredValue: group.deliveredValue,
        valueGap: group.requiredValue - group.deliveredValue,
        valueDeliveredPercent: toPercentValue(group.deliveredValue, group.requiredValue),
      }))
      .sort((a, b) => {
        const aTime = a.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        const bTime = b.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
  }, [annualContractVintageRows]);

  // -------------------------------------------------------------------------
  // Per-contract totals (across all vintages)
  // -------------------------------------------------------------------------
  const annualContractSummaryRows = useMemo(() => {
    const groups = new Map<
      string,
      {
        contractId: string;
        required: number;
        delivered: number;
        requiredValue: number;
        deliveredValue: number;
        projectCount: number;
        reportingProjectCount: number;
        startDates: Set<string>;
      }
    >();

    annualContractVintageRows.forEach((row) => {
      let current = groups.get(row.contractId);
      if (!current) {
        current = {
          contractId: row.contractId,
          required: 0,
          delivered: 0,
          requiredValue: 0,
          deliveredValue: 0,
          projectCount: 0,
          reportingProjectCount: 0,
          startDates: new Set<string>(),
        };
        groups.set(row.contractId, current);
      }

      current.required += row.required;
      current.delivered += row.delivered;
      current.requiredValue += row.requiredValue;
      current.deliveredValue += row.deliveredValue;
      current.projectCount += row.projectCount;
      current.reportingProjectCount += row.reportingProjectCount;
      current.startDates.add(
        row.deliveryStartDate ? formatDate(row.deliveryStartDate) : row.deliveryStartRaw,
      );
    });

    return Array.from(groups.values())
      .map((group) => ({
        contractId: group.contractId,
        projectCount: group.projectCount,
        reportingProjectCount: group.reportingProjectCount,
        reportingProjectPercent: toPercentValue(
          group.reportingProjectCount,
          group.projectCount,
        ),
        startDateCount: group.startDates.size,
        required: group.required,
        delivered: group.delivered,
        gap: group.required - group.delivered,
        deliveredPercent: toPercentValue(group.delivered, group.required),
        requiredValue: group.requiredValue,
        deliveredValue: group.deliveredValue,
        valueGap: group.requiredValue - group.deliveredValue,
        valueDeliveredPercent: toPercentValue(group.deliveredValue, group.requiredValue),
      }))
      .sort((a, b) => a.contractId.localeCompare(b.contractId));
  }, [annualContractVintageRows]);

  // -------------------------------------------------------------------------
  // Portfolio-level summary cards (totals + 3-year rolling averages)
  // -------------------------------------------------------------------------
  const annualPortfolioSummary = useMemo(() => {
    const totalRequired = annualVintageRows.reduce((sum, row) => sum + row.required, 0);
    const totalDelivered = annualVintageRows.reduce((sum, row) => sum + row.delivered, 0);
    const totalRequiredValue = annualVintageRows.reduce(
      (sum, row) => sum + row.requiredValue,
      0,
    );
    const totalDeliveredValue = annualVintageRows.reduce(
      (sum, row) => sum + row.deliveredValue,
      0,
    );
    const totalProjects = annualVintageRows.reduce(
      (sum, row) => sum + row.projectCount,
      0,
    );
    const totalReportingProjects = annualVintageRows.reduce(
      (sum, row) => sum + row.reportingProjectCount,
      0,
    );

    const latestVintage =
      annualVintageRows.length > 0 ? annualVintageRows[annualVintageRows.length - 1] : null;
    const rollingThreeRows = annualVintageRows.slice(-3);
    const rollingThreeRequired = rollingThreeRows.reduce((sum, row) => sum + row.required, 0);
    const rollingThreeDelivered = rollingThreeRows.reduce(
      (sum, row) => sum + row.delivered,
      0,
    );
    const rollingThreeRequiredValue = rollingThreeRows.reduce(
      (sum, row) => sum + row.requiredValue,
      0,
    );
    const rollingThreeDeliveredValue = rollingThreeRows.reduce(
      (sum, row) => sum + row.deliveredValue,
      0,
    );

    return {
      totalRequired,
      totalDelivered,
      totalGap: totalRequired - totalDelivered,
      totalDeliveredPercent: toPercentValue(totalDelivered, totalRequired),
      totalRequiredValue,
      totalDeliveredValue,
      totalValueGap: totalRequiredValue - totalDeliveredValue,
      totalValueDeliveredPercent: toPercentValue(totalDeliveredValue, totalRequiredValue),
      totalProjects,
      totalReportingProjects,
      totalReportingProjectPercent: toPercentValue(totalReportingProjects, totalProjects),
      vintageCount: annualVintageRows.length,
      latestVintage,
      rollingThreeRequired,
      rollingThreeDelivered,
      rollingThreeDeliveredPercent: toPercentValue(
        rollingThreeDelivered,
        rollingThreeRequired,
      ),
      rollingThreeRequiredValue,
      rollingThreeDeliveredValue,
      rollingThreeValueDeliveredPercent: toPercentValue(
        rollingThreeDeliveredValue,
        rollingThreeRequiredValue,
      ),
    };
  }, [annualVintageRows]);

  // -------------------------------------------------------------------------
  // Pagination + chart projection
  // -------------------------------------------------------------------------
  const annualContractVintageTotalPages = Math.max(
    1,
    Math.ceil(annualContractVintageRows.length / ANNUAL_CONTRACT_VINTAGE_PAGE_SIZE),
  );
  const annualContractVintageCurrentPage = Math.min(
    annualContractVintagePage,
    annualContractVintageTotalPages,
  );
  const annualContractVintagePageStartIndex =
    (annualContractVintageCurrentPage - 1) * ANNUAL_CONTRACT_VINTAGE_PAGE_SIZE;
  const annualContractVintagePageEndIndex =
    annualContractVintagePageStartIndex + ANNUAL_CONTRACT_VINTAGE_PAGE_SIZE;
  const visibleAnnualContractVintageRows = useMemo(
    () =>
      annualContractVintageRows.slice(
        annualContractVintagePageStartIndex,
        annualContractVintagePageEndIndex,
      ),
    [
      annualContractVintagePageEndIndex,
      annualContractVintagePageStartIndex,
      annualContractVintageRows,
    ],
  );

  const annualContractSummaryTotalPages = Math.max(
    1,
    Math.ceil(annualContractSummaryRows.length / ANNUAL_CONTRACT_SUMMARY_PAGE_SIZE),
  );
  const annualContractSummaryCurrentPage = Math.min(
    annualContractSummaryPage,
    annualContractSummaryTotalPages,
  );
  const annualContractSummaryPageStartIndex =
    (annualContractSummaryCurrentPage - 1) * ANNUAL_CONTRACT_SUMMARY_PAGE_SIZE;
  const annualContractSummaryPageEndIndex =
    annualContractSummaryPageStartIndex + ANNUAL_CONTRACT_SUMMARY_PAGE_SIZE;
  const visibleAnnualContractSummaryRows = useMemo(
    () =>
      annualContractSummaryRows.slice(
        annualContractSummaryPageStartIndex,
        annualContractSummaryPageEndIndex,
      ),
    [
      annualContractSummaryPageEndIndex,
      annualContractSummaryPageStartIndex,
      annualContractSummaryRows,
    ],
  );

  const annualVintageTrendChartRows = useMemo(
    () =>
      annualVintageRows.map((row) => ({
        label: row.label,
        required: row.required,
        delivered: row.delivered,
        deliveredPercent: row.deliveredPercent ?? 0,
      })),
    [annualVintageRows],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Annual REC Delivery Obligation Review</CardTitle>
          <CardDescription>
            Excel-aligned annual view based on Project Delivery Start Date (
            <code>year1_start_date</code>) and Utility Contract ID.
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Card>
          <CardHeader>
            <CardDescription>Annual Required RECs</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(annualPortfolioSummary.totalRequired)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Annual Delivered RECs</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(annualPortfolioSummary.totalDelivered)}
            </CardTitle>
            <CardDescription>
              {formatPercent(annualPortfolioSummary.totalDeliveredPercent)}
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>REC Gap</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(annualPortfolioSummary.totalGap)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Required Value</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(annualPortfolioSummary.totalRequiredValue)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Delivered Value</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(annualPortfolioSummary.totalDeliveredValue)}
            </CardTitle>
            <CardDescription>
              {formatPercent(annualPortfolioSummary.totalValueDeliveredPercent)}
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Value Gap</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(annualPortfolioSummary.totalValueGap)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Delivery Vintages</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(annualPortfolioSummary.vintageCount)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Reporting Projects</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(annualPortfolioSummary.totalReportingProjects)}
            </CardTitle>
            <CardDescription>
              {formatPercent(annualPortfolioSummary.totalReportingProjectPercent)}
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>3-Year Rolling Delivery %</CardDescription>
            <CardTitle className="text-2xl">
              {formatPercent(annualPortfolioSummary.rollingThreeDeliveredPercent)}
            </CardTitle>
            <CardDescription>
              {formatNumber(annualPortfolioSummary.rollingThreeDelivered)} /{" "}
              {formatNumber(annualPortfolioSummary.rollingThreeRequired)} RECs
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>3-Year Rolling Value %</CardDescription>
            <CardTitle className="text-2xl">
              {formatPercent(annualPortfolioSummary.rollingThreeValueDeliveredPercent)}
            </CardTitle>
            <CardDescription>
              {formatCurrency(annualPortfolioSummary.rollingThreeDeliveredValue)} /{" "}
              {formatCurrency(annualPortfolioSummary.rollingThreeRequiredValue)}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Annual Vintage Trend (Required vs Delivered)
          </CardTitle>
          <CardDescription>
            Trend by Project Delivery Start Date with delivered percent overlay.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={annualVintageTrendChartRows}
                margin={{ top: 10, right: 16, left: 8, bottom: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  domain={[0, 100]}
                  tickFormatter={(value: number) => `${value}%`}
                  tick={{ fontSize: 11 }}
                />
                <Tooltip
                  formatter={(value: number, name: string) => {
                    if (name === "Delivered %") return [`${formatNumber(value, 1)}%`, name];
                    return [formatNumber(value), name];
                  }}
                />
                <Legend />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="required"
                  stroke="#64748b"
                  strokeWidth={2}
                  dot
                  name="Required RECs"
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="delivered"
                  stroke="#16a34a"
                  strokeWidth={2}
                  dot
                  name="Delivered RECs"
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="deliveredPercent"
                  stroke="#2563eb"
                  strokeWidth={2}
                  dot={false}
                  name="Delivered %"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Annual Vintage Summary</CardTitle>
          <CardDescription>
            Aggregated across all contracts by Project Delivery Start Date (June 1
            vintages).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project Delivery Start Date</TableHead>
                <TableHead>Projects</TableHead>
                <TableHead>Reporting Projects</TableHead>
                <TableHead>Reporting %</TableHead>
                <TableHead>Required</TableHead>
                <TableHead>Delivered</TableHead>
                <TableHead>Delivered %</TableHead>
                <TableHead>Required Value</TableHead>
                <TableHead>Delivered Value</TableHead>
                <TableHead>Value Delivered %</TableHead>
                <TableHead>REC Gap</TableHead>
                <TableHead>Value Gap</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {annualVintageRows.map((row) => (
                <TableRow
                  key={
                    row.deliveryStartDate
                      ? row.deliveryStartDate.toISOString()
                      : row.deliveryStartRaw
                  }
                >
                  <TableCell className="font-medium">{row.label}</TableCell>
                  <TableCell>{formatNumber(row.projectCount)}</TableCell>
                  <TableCell>{formatNumber(row.reportingProjectCount)}</TableCell>
                  <TableCell>{formatPercent(row.reportingProjectPercent)}</TableCell>
                  <TableCell>{formatNumber(row.required)}</TableCell>
                  <TableCell>{formatNumber(row.delivered)}</TableCell>
                  <TableCell>{formatPercent(row.deliveredPercent)}</TableCell>
                  <TableCell>{formatCurrency(row.requiredValue)}</TableCell>
                  <TableCell>{formatCurrency(row.deliveredValue)}</TableCell>
                  <TableCell>{formatPercent(row.valueDeliveredPercent)}</TableCell>
                  <TableCell className={row.gap > 0 ? "text-amber-700" : ""}>
                    {formatNumber(row.gap)}
                  </TableCell>
                  <TableCell className={row.valueGap > 0 ? "text-amber-700" : ""}>
                    {formatCurrency(row.valueGap)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contract + Vintage Annual Detail</CardTitle>
          <CardDescription>
            Combined by Utility Contract ID and Project Delivery Start Date.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>
              Showing {formatNumber(visibleAnnualContractVintageRows.length)} of{" "}
              {formatNumber(annualContractVintageRows.length)} rows
            </span>
            <span>
              Page {formatNumber(annualContractVintageCurrentPage)} of{" "}
              {formatNumber(annualContractVintageTotalPages)}
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Utility Contract ID</TableHead>
                <TableHead>Project Delivery Start Date</TableHead>
                <TableHead>Projects</TableHead>
                <TableHead>Reporting Projects</TableHead>
                <TableHead>Reporting %</TableHead>
                <TableHead>Required</TableHead>
                <TableHead>Delivered</TableHead>
                <TableHead>Delivered %</TableHead>
                <TableHead>Required Value</TableHead>
                <TableHead>Delivered Value</TableHead>
                <TableHead>Value Delivered %</TableHead>
                <TableHead>REC Gap</TableHead>
                <TableHead>Value Gap</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleAnnualContractVintageRows.map((row) => (
                <TableRow key={`${row.contractId}-${row.deliveryStartRaw}`}>
                  <TableCell className="font-medium">{row.contractId}</TableCell>
                  <TableCell>
                    {row.deliveryStartDate
                      ? formatDate(row.deliveryStartDate)
                      : row.deliveryStartRaw}
                  </TableCell>
                  <TableCell>{formatNumber(row.projectCount)}</TableCell>
                  <TableCell>{formatNumber(row.reportingProjectCount)}</TableCell>
                  <TableCell>{formatPercent(row.reportingProjectPercent)}</TableCell>
                  <TableCell>{formatNumber(row.required)}</TableCell>
                  <TableCell>{formatNumber(row.delivered)}</TableCell>
                  <TableCell>{formatPercent(row.deliveredPercent)}</TableCell>
                  <TableCell>{formatCurrency(row.requiredValue)}</TableCell>
                  <TableCell>{formatCurrency(row.deliveredValue)}</TableCell>
                  <TableCell>{formatPercent(row.valueDeliveredPercent)}</TableCell>
                  <TableCell className={row.gap > 0 ? "text-amber-700" : ""}>
                    {formatNumber(row.gap)}
                  </TableCell>
                  <TableCell className={row.valueGap > 0 ? "text-amber-700" : ""}>
                    {formatCurrency(row.valueGap)}
                  </TableCell>
                </TableRow>
              ))}
              {visibleAnnualContractVintageRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={13} className="py-6 text-center text-slate-500">
                    No annual contract vintage rows available.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAnnualContractVintagePage((page) => Math.max(1, page - 1))}
              disabled={annualContractVintageCurrentPage <= 1}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setAnnualContractVintagePage((page) =>
                  Math.min(annualContractVintageTotalPages, page + 1),
                )
              }
              disabled={annualContractVintageCurrentPage >= annualContractVintageTotalPages}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Annual Contract Totals</CardTitle>
          <CardDescription>
            Contract-level annual totals across all start dates.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>
              Showing {formatNumber(visibleAnnualContractSummaryRows.length)} of{" "}
              {formatNumber(annualContractSummaryRows.length)} rows
            </span>
            <span>
              Page {formatNumber(annualContractSummaryCurrentPage)} of{" "}
              {formatNumber(annualContractSummaryTotalPages)}
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Utility Contract ID</TableHead>
                <TableHead>Start Dates</TableHead>
                <TableHead>Projects</TableHead>
                <TableHead>Reporting Projects</TableHead>
                <TableHead>Reporting %</TableHead>
                <TableHead>Required</TableHead>
                <TableHead>Delivered</TableHead>
                <TableHead>Delivered %</TableHead>
                <TableHead>Required Value</TableHead>
                <TableHead>Delivered Value</TableHead>
                <TableHead>Value Delivered %</TableHead>
                <TableHead>REC Gap</TableHead>
                <TableHead>Value Gap</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleAnnualContractSummaryRows.map((row) => (
                <TableRow key={row.contractId}>
                  <TableCell className="font-medium">{row.contractId}</TableCell>
                  <TableCell>{formatNumber(row.startDateCount)}</TableCell>
                  <TableCell>{formatNumber(row.projectCount)}</TableCell>
                  <TableCell>{formatNumber(row.reportingProjectCount)}</TableCell>
                  <TableCell>{formatPercent(row.reportingProjectPercent)}</TableCell>
                  <TableCell>{formatNumber(row.required)}</TableCell>
                  <TableCell>{formatNumber(row.delivered)}</TableCell>
                  <TableCell>{formatPercent(row.deliveredPercent)}</TableCell>
                  <TableCell>{formatCurrency(row.requiredValue)}</TableCell>
                  <TableCell>{formatCurrency(row.deliveredValue)}</TableCell>
                  <TableCell>{formatPercent(row.valueDeliveredPercent)}</TableCell>
                  <TableCell className={row.gap > 0 ? "text-amber-700" : ""}>
                    {formatNumber(row.gap)}
                  </TableCell>
                  <TableCell className={row.valueGap > 0 ? "text-amber-700" : ""}>
                    {formatCurrency(row.valueGap)}
                  </TableCell>
                </TableRow>
              ))}
              {visibleAnnualContractSummaryRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={13} className="py-6 text-center text-slate-500">
                    No annual contract summary rows available.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAnnualContractSummaryPage((page) => Math.max(1, page - 1))}
              disabled={annualContractSummaryCurrentPage <= 1}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setAnnualContractSummaryPage((page) =>
                  Math.min(annualContractSummaryTotalPages, page + 1),
                )
              }
              disabled={annualContractSummaryCurrentPage >= annualContractSummaryTotalPages}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      <AskAiPanel
        moduleKey="solar-rec-annual-review"
        title="Ask AI about the annual REC review"
        contextGetter={() => ({
          portfolio: annualPortfolioSummary,
          vintageRows: annualVintageRows.map((r) => ({
            label: r.label,
            required: r.required,
            delivered: r.delivered,
            gap: r.gap,
            requiredValue: r.requiredValue,
            deliveredValue: r.deliveredValue,
            projectCount: r.projectCount,
            reportingProjectCount: r.reportingProjectCount,
          })),
          // Worst-gap contract/vintage pairs first
          sampleContractVintages: [...annualContractVintageRows]
            .sort(
              (a, b) =>
                b.required - b.delivered - (a.required - a.delivered)
            )
            .slice(0, 20)
            .map((r) => ({
              contractId: r.contractId,
              deliveryStartRaw: r.deliveryStartRaw,
              required: r.required,
              delivered: r.delivered,
              requiredValue: r.requiredValue,
              deliveredValue: r.deliveredValue,
              projectCount: r.projectCount,
            })),
          trendChartRows: annualVintageTrendChartRows,
        })}
      />
    </div>
  );
});
