/**
 * Utility Contracts tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 6 of the
 * god-component decomposition — the first pass at unwinding the REC
 * performance spine. Owns:
 *   - 1 useState (contractSummaryPage, contractDetailPage)
 *   - 5 useMemos (contractDeliveryRows, contractSummaryRows,
 *     visibleContractSummaryRows, visibleContractDeliveryRows,
 *     contractPerformanceChartRows)
 *   - ~210 lines of JSX (chart + summary table + detail table)
 *
 * The parent still owns the four spine foundation memos
 * (`recPriceByTrackingId`, `eligibleTrackingIds`, `systemsByTrackingId`,
 * `transferDeliveryLookup`) because Performance Eval, Snapshot Log,
 * and Forecast all read from them too. They come in as props.
 *
 * `performanceSourceRows` and the rest of the deeper spine stay in the
 * parent — extracting those is a future phase because Forecast and the
 * AI chat context also depend on them.
 */

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
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
  CONTRACT_DETAIL_PAGE_SIZE,
  CONTRACT_SUMMARY_PAGE_SIZE,
} from "@/solar-rec-dashboard/lib/constants";
import type {
  ContractDeliveryAggregate,
  CsvDataset,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ContractsTabProps {
  /** Phase 1a delivery obligation rows from the schedule base CSV. */
  deliveryScheduleBase: CsvDataset | null;
  /** Set of trackingSystemRefIds that pass the Part-2-verification gate. */
  eligibleTrackingIds: Set<string>;
  /** Per-tracking-ID REC price (used to value required vs delivered). */
  recPriceByTrackingId: Map<string, number>;
  /** Per-tracking-ID, per-energy-year delivered REC quantity from GATS. */
  transferDeliveryLookup: Map<string, Map<number, number>>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ContractsTab(props: ContractsTabProps) {
  const {
    deliveryScheduleBase,
    eligibleTrackingIds,
    recPriceByTrackingId,
    transferDeliveryLookup,
  } = props;

  const [contractSummaryPage, setContractSummaryPage] = useState(1);
  const [contractDetailPage, setContractDetailPage] = useState(1);

  // -------------------------------------------------------------------------
  // Aggregate per (contractId, deliveryStartDate) from the schedule base.
  // Required values come from year1_quantity_required; delivered values
  // come from the GATS transfer lookup bucketed into that energy year.
  // -------------------------------------------------------------------------
  const contractDeliveryRows = useMemo<ContractDeliveryAggregate[]>(() => {
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
        pricedTrackingIds: Set<string>;
      }
    >();

    (deliveryScheduleBase?.rows ?? []).forEach((row) => {
      const contractId = clean(row.utility_contract_number) || "Unassigned";
      const trackingId = clean(row.tracking_system_ref_id);
      if (!trackingId || !eligibleTrackingIds.has(trackingId)) return;

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
        ? `${deliveryStartDate.getFullYear()}-${String(
            deliveryStartDate.getMonth() + 1,
          ).padStart(2, "0")}-${String(deliveryStartDate.getDate()).padStart(2, "0")}`
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
          pricedTrackingIds: new Set<string>(),
        };
        groups.set(key, current);
      }

      current.required += required;
      current.delivered += delivered;
      current.trackingIds.add(trackingId);
      if (recPrice !== null) {
        current.requiredValue += required * recPrice;
        current.deliveredValue += delivered * recPrice;
        current.pricedTrackingIds.add(trackingId);
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
        pricedProjectCount: group.pricedTrackingIds.size,
      }))
      .sort((a, b) => {
        const contractCompare = a.contractId.localeCompare(b.contractId);
        if (contractCompare !== 0) return contractCompare;
        const aTime = a.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        const bTime = b.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
  }, [
    deliveryScheduleBase,
    eligibleTrackingIds,
    recPriceByTrackingId,
    transferDeliveryLookup,
  ]);

  // -------------------------------------------------------------------------
  // Roll the per-(contract, start-date) detail rows up to one row per contract
  // -------------------------------------------------------------------------
  const contractSummaryRows = useMemo(() => {
    const groups = new Map<
      string,
      {
        contractId: string;
        required: number;
        delivered: number;
        requiredValue: number;
        deliveredValue: number;
        startDates: Set<string>;
        projectCount: number;
        pricedProjectCount: number;
      }
    >();

    contractDeliveryRows.forEach((row) => {
      let current = groups.get(row.contractId);
      if (!current) {
        current = {
          contractId: row.contractId,
          required: 0,
          delivered: 0,
          requiredValue: 0,
          deliveredValue: 0,
          startDates: new Set<string>(),
          projectCount: 0,
          pricedProjectCount: 0,
        };
        groups.set(row.contractId, current);
      }
      current.required += row.required;
      current.delivered += row.delivered;
      current.requiredValue += row.requiredValue;
      current.deliveredValue += row.deliveredValue;
      current.startDates.add(
        row.deliveryStartDate ? formatDate(row.deliveryStartDate) : row.deliveryStartRaw,
      );
      current.projectCount += row.projectCount;
      current.pricedProjectCount += row.pricedProjectCount;
    });

    return Array.from(groups.values())
      .map((group) => ({
        contractId: group.contractId,
        required: group.required,
        delivered: group.delivered,
        gap: group.required - group.delivered,
        deliveredPercent: toPercentValue(group.delivered, group.required),
        requiredValue: group.requiredValue,
        deliveredValue: group.deliveredValue,
        valueGap: group.requiredValue - group.deliveredValue,
        valueDeliveredPercent: toPercentValue(group.deliveredValue, group.requiredValue),
        startDateCount: group.startDates.size,
        projectCount: group.projectCount,
        pricedProjectCount: group.pricedProjectCount,
      }))
      .sort((a, b) => a.contractId.localeCompare(b.contractId));
  }, [contractDeliveryRows]);

  // -------------------------------------------------------------------------
  // Pagination + chart projection
  // -------------------------------------------------------------------------
  const contractSummaryTotalPages = Math.max(
    1,
    Math.ceil(contractSummaryRows.length / CONTRACT_SUMMARY_PAGE_SIZE),
  );
  const contractSummaryCurrentPage = Math.min(
    contractSummaryPage,
    contractSummaryTotalPages,
  );
  const contractSummaryPageStartIndex =
    (contractSummaryCurrentPage - 1) * CONTRACT_SUMMARY_PAGE_SIZE;
  const contractSummaryPageEndIndex =
    contractSummaryPageStartIndex + CONTRACT_SUMMARY_PAGE_SIZE;
  const visibleContractSummaryRows = useMemo(
    () =>
      contractSummaryRows.slice(
        contractSummaryPageStartIndex,
        contractSummaryPageEndIndex,
      ),
    [contractSummaryPageEndIndex, contractSummaryPageStartIndex, contractSummaryRows],
  );

  const contractDetailTotalPages = Math.max(
    1,
    Math.ceil(contractDeliveryRows.length / CONTRACT_DETAIL_PAGE_SIZE),
  );
  const contractDetailCurrentPage = Math.min(
    contractDetailPage,
    contractDetailTotalPages,
  );
  const contractDetailPageStartIndex =
    (contractDetailCurrentPage - 1) * CONTRACT_DETAIL_PAGE_SIZE;
  const contractDetailPageEndIndex =
    contractDetailPageStartIndex + CONTRACT_DETAIL_PAGE_SIZE;
  const visibleContractDeliveryRows = useMemo(
    () =>
      contractDeliveryRows.slice(
        contractDetailPageStartIndex,
        contractDetailPageEndIndex,
      ),
    [contractDeliveryRows, contractDetailPageEndIndex, contractDetailPageStartIndex],
  );

  const contractPerformanceChartRows = useMemo(
    () =>
      contractSummaryRows
        .map((row) => ({
          contractId: row.contractId,
          required: row.required,
          delivered: row.delivered,
          deliveredPercent: row.deliveredPercent ?? 0,
        }))
        .slice(0, 20),
    [contractSummaryRows],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Utility Contract ID Tracking</CardTitle>
          <CardDescription>
            Aggregated by Utility Contract ID and <code>year1_start_date</code>. Matching
            Contract ID + start date rows are combined.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contract Delivery Performance Chart</CardTitle>
          <CardDescription>
            Required vs delivered RECs by contract ID (top 20 rows shown), with delivered
            percent overlay.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={contractPerformanceChartRows}
                margin={{ top: 10, right: 16, left: 8, bottom: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="contractId" tick={{ fontSize: 11 }} />
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
                <Bar yAxisId="left" dataKey="required" fill="#94a3b8" name="Required RECs" />
                <Bar yAxisId="left" dataKey="delivered" fill="#16a34a" name="Delivered RECs" />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="deliveredPercent"
                  stroke="#2563eb"
                  strokeWidth={2}
                  dot={false}
                  name="Delivered %"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contract Summary</CardTitle>
          <CardDescription>Total required vs delivered by Utility Contract ID.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>
              Showing {formatNumber(visibleContractSummaryRows.length)} of{" "}
              {formatNumber(contractSummaryRows.length)} rows
            </span>
            <span>
              Page {formatNumber(contractSummaryCurrentPage)} of{" "}
              {formatNumber(contractSummaryTotalPages)}
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Utility Contract ID</TableHead>
                <TableHead>Start Dates</TableHead>
                <TableHead>Projects</TableHead>
                <TableHead>Total Required</TableHead>
                <TableHead>Total Delivered</TableHead>
                <TableHead>Delivered %</TableHead>
                <TableHead>Contracted Value</TableHead>
                <TableHead>Delivered Value</TableHead>
                <TableHead>Value Delivered %</TableHead>
                <TableHead>Gap</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleContractSummaryRows.map((row) => (
                <TableRow key={row.contractId}>
                  <TableCell className="font-medium">{row.contractId}</TableCell>
                  <TableCell>{formatNumber(row.startDateCount)}</TableCell>
                  <TableCell>{formatNumber(row.projectCount)}</TableCell>
                  <TableCell>{formatNumber(row.required)}</TableCell>
                  <TableCell>{formatNumber(row.delivered)}</TableCell>
                  <TableCell>{formatPercent(row.deliveredPercent)}</TableCell>
                  <TableCell>{formatCurrency(row.requiredValue)}</TableCell>
                  <TableCell>{formatCurrency(row.deliveredValue)}</TableCell>
                  <TableCell>{formatPercent(row.valueDeliveredPercent)}</TableCell>
                  <TableCell className={row.gap > 0 ? "text-amber-700" : ""}>
                    {formatNumber(row.gap)}
                  </TableCell>
                </TableRow>
              ))}
              {visibleContractSummaryRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-6 text-center text-slate-500">
                    No contract summary rows available for current filters.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setContractSummaryPage((page) => Math.max(1, page - 1))}
              disabled={contractSummaryCurrentPage <= 1}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setContractSummaryPage((page) =>
                  Math.min(contractSummaryTotalPages, page + 1),
                )
              }
              disabled={contractSummaryCurrentPage >= contractSummaryTotalPages}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contract + Delivery Start Date Detail</CardTitle>
          <CardDescription>
            For matching contract ID and start date, required and delivered values are
            aggregated.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>
              Showing {formatNumber(visibleContractDeliveryRows.length)} of{" "}
              {formatNumber(contractDeliveryRows.length)} rows
            </span>
            <span>
              Page {formatNumber(contractDetailCurrentPage)} of{" "}
              {formatNumber(contractDetailTotalPages)}
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Utility Contract ID</TableHead>
                <TableHead>Project Delivery Start Date</TableHead>
                <TableHead>Projects</TableHead>
                <TableHead>Priced Projects</TableHead>
                <TableHead>Required</TableHead>
                <TableHead>Delivered</TableHead>
                <TableHead>Delivered %</TableHead>
                <TableHead>Contracted Value</TableHead>
                <TableHead>Delivered Value</TableHead>
                <TableHead>Value Delivered %</TableHead>
                <TableHead>Gap</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleContractDeliveryRows.map((row) => (
                <TableRow key={`${row.contractId}-${row.deliveryStartRaw}`}>
                  <TableCell className="font-medium">{row.contractId}</TableCell>
                  <TableCell>
                    {row.deliveryStartDate
                      ? formatDate(row.deliveryStartDate)
                      : row.deliveryStartRaw}
                  </TableCell>
                  <TableCell>{formatNumber(row.projectCount)}</TableCell>
                  <TableCell>{formatNumber(row.pricedProjectCount)}</TableCell>
                  <TableCell>{formatNumber(row.required)}</TableCell>
                  <TableCell>{formatNumber(row.delivered)}</TableCell>
                  <TableCell>{formatPercent(row.deliveredPercent)}</TableCell>
                  <TableCell>{formatCurrency(row.requiredValue)}</TableCell>
                  <TableCell>{formatCurrency(row.deliveredValue)}</TableCell>
                  <TableCell>{formatPercent(row.valueDeliveredPercent)}</TableCell>
                  <TableCell className={row.gap > 0 ? "text-amber-700" : ""}>
                    {formatNumber(row.gap)}
                  </TableCell>
                </TableRow>
              ))}
              {visibleContractDeliveryRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="py-6 text-center text-slate-500">
                    No contract delivery rows available for current filters.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setContractDetailPage((page) => Math.max(1, page - 1))}
              disabled={contractDetailCurrentPage <= 1}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setContractDetailPage((page) =>
                  Math.min(contractDetailTotalPages, page + 1),
                )
              }
              disabled={contractDetailCurrentPage >= contractDetailTotalPages}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
