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
import { clean, formatCurrency, formatPercent } from "@/lib/helpers";
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
  parseDate,
  parseNumber,
  toPercentValue,
} from "@/solar-rec-dashboard/lib/helpers";
import { getDeliveredForYear } from "@/solar-rec-dashboard/lib/transferHistoryDeliveries";
import {
  ANNUAL_CONTRACT_SUMMARY_PAGE_SIZE,
  ANNUAL_CONTRACT_VINTAGE_PAGE_SIZE,
} from "@/solar-rec-dashboard/lib/constants";
import type {
  AnnualContractVintageAggregate,
  AnnualVintageAggregate,
  CsvDataset,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AnnualReviewTabProps {
  /** Phase 1a delivery obligation rows from the schedule base CSV. */
  deliveryScheduleBase: CsvDataset | null;
  /** Set of trackingSystemRefIds that pass the Part-2-verification gate. */
  eligibleTrackingIds: Set<string>;
  /** Per-tracking-ID REC price (used to value required vs delivered). */
  recPriceByTrackingId: Map<string, number>;
  /**
   * Per-tracking-ID system lookup. The reporting-project counts in
   * the annual vintage table read `.isReporting` from this map.
   */
  systemsByTrackingId: Map<string, SystemRecord>;
  /** Per-tracking-ID, per-energy-year delivered REC quantity from GATS. */
  transferDeliveryLookup: Map<string, Map<number, number>>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function AnnualReviewTab(props: AnnualReviewTabProps) {
  const {
    deliveryScheduleBase,
    eligibleTrackingIds,
    recPriceByTrackingId,
    systemsByTrackingId,
    transferDeliveryLookup,
  } = props;

  const [annualContractVintagePage, setAnnualContractVintagePage] = useState(1);
  const [annualContractSummaryPage, setAnnualContractSummaryPage] = useState(1);

  // -------------------------------------------------------------------------
  // Per (contractId, deliveryStartDate) aggregation. Same shape as the
  // Contracts tab's `contractDeliveryRows` but with reportingProject
  // counts so the annual review can show what % of each vintage's
  // projects are still reporting.
  // -------------------------------------------------------------------------
  const annualContractVintageRows = useMemo<AnnualContractVintageAggregate[]>(() => {
    const groups = new Map<
      string,
      {
        contractId: string;
        deliveryStartDate: Date | null;
        deliveryStartRaw: string;
        required: number;
        delivered: number;
        requiredValue: number;
        deliveredValue: number;
        trackingIds: Set<string>;
        reportingTrackingIds: Set<string>;
      }
    >();

    (deliveryScheduleBase?.rows ?? []).forEach((row) => {
      const trackingId = clean(row.tracking_system_ref_id);
      if (!trackingId || !eligibleTrackingIds.has(trackingId)) return;

      const contractId = clean(row.utility_contract_number) || "Unassigned";
      const deliveryStartRaw = clean(row.year1_start_date);
      if (!deliveryStartRaw) return;

      const deliveryStartDate = parseDate(deliveryStartRaw);
      const required = parseNumber(row.year1_quantity_required) ?? 0;
      const delivered = deliveryStartDate
        ? getDeliveredForYear(
            transferDeliveryLookup,
            trackingId,
            deliveryStartDate.getFullYear(),
          )
        : 0;
      const recPrice = recPriceByTrackingId.get(trackingId) ?? null;

      const dateKey = deliveryStartDate
        ? toDateKey(deliveryStartDate)
        : deliveryStartRaw;
      const key = `${contractId}__${dateKey}`;

      let current = groups.get(key);
      if (!current) {
        current = {
          contractId,
          deliveryStartDate,
          deliveryStartRaw,
          required: 0,
          delivered: 0,
          requiredValue: 0,
          deliveredValue: 0,
          trackingIds: new Set<string>(),
          reportingTrackingIds: new Set<string>(),
        };
        groups.set(key, current);
      }

      current.required += required;
      current.delivered += delivered;
      current.trackingIds.add(trackingId);
      if (recPrice !== null) {
        current.requiredValue += required * recPrice;
        current.deliveredValue += delivered * recPrice;
      }
      if (systemsByTrackingId.get(trackingId)?.isReporting) {
        current.reportingTrackingIds.add(trackingId);
      }
    });

    return Array.from(groups.values())
      .map((group) => ({
        contractId: group.contractId,
        deliveryStartDate: group.deliveryStartDate,
        deliveryStartRaw: group.deliveryStartRaw,
        required: group.required,
        delivered: group.delivered,
        gap: group.required - group.delivered,
        deliveredPercent: toPercentValue(group.delivered, group.required),
        requiredValue: group.requiredValue,
        deliveredValue: group.deliveredValue,
        valueGap: group.requiredValue - group.deliveredValue,
        valueDeliveredPercent: toPercentValue(group.deliveredValue, group.requiredValue),
        projectCount: group.trackingIds.size,
        reportingProjectCount: group.reportingTrackingIds.size,
        reportingProjectPercent: toPercentValue(
          group.reportingTrackingIds.size,
          group.trackingIds.size,
        ),
      }))
      .sort((a, b) => {
        const aTime = a.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        const bTime = b.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        if (aTime !== bTime) return aTime - bTime;
        return a.contractId.localeCompare(b.contractId);
      });
  }, [
    deliveryScheduleBase,
    eligibleTrackingIds,
    recPriceByTrackingId,
    systemsByTrackingId,
    transferDeliveryLookup,
  ]);

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
    </div>
  );
});
