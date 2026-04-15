/**
 * REC Value tab.
 *
 * Extracted from SolarRecDashboard.tsx. Phase 8. Owns:
 *   - 1 useState (recValuePage)
 *   - 1 useMemo (visibleRecValueRows — pagination slice)
 *
 * Receives the upstream memos `recValueRows`, `snapshotPart2ValueSummary`,
 * `recValueByStatusChartRows`, `recTopGapChartRows` as props. All four
 * stay in the parent: `snapshotPart2ValueSummary` is also consumed by
 * `createLogEntry` for dashboard snapshots, and the chart memos are
 * cheap derivations we keep colocated with their sources.
 */

import { useMemo, useState } from "react";
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
import { formatCurrency, formatPercent } from "@/lib/helpers";
import {
  formatNumber,
  resolveContractValueAmount,
  resolveValueGapAmount,
  toPercentValue,
} from "@/solar-rec-dashboard/lib/helpers";
import { REC_VALUE_PAGE_SIZE } from "@/solar-rec-dashboard/lib/constants";
import type { SystemRecord } from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type RecValueByStatusChartRow = {
  label: string;
  contractedValue: number;
  deliveredValue: number;
};

export type RecTopGapChartRow = {
  label: string;
  valueGap: number;
};

export type RecValueSnapshotSummary = {
  totalContractedValue: number;
  totalDeliveredValue: number;
  totalGap: number;
  contractedValueReporting: number;
  contractedValueNotReporting: number;
  contractedValueReportingPercent: number | null;
};

export interface RecValueTabProps {
  recValueRows: SystemRecord[];
  snapshotPart2ValueSummary: RecValueSnapshotSummary;
  recValueByStatusChartRows: RecValueByStatusChartRow[];
  recTopGapChartRows: RecTopGapChartRow[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RecValueTab(props: RecValueTabProps) {
  const {
    recValueRows,
    snapshotPart2ValueSummary,
    recValueByStatusChartRows,
    recTopGapChartRows,
  } = props;

  const [recValuePage, setRecValuePage] = useState(1);

  const recValueTotalPages = Math.max(
    1,
    Math.ceil(recValueRows.length / REC_VALUE_PAGE_SIZE),
  );
  const recValueCurrentPage = Math.min(recValuePage, recValueTotalPages);
  const recValuePageStartIndex = (recValueCurrentPage - 1) * REC_VALUE_PAGE_SIZE;
  const recValuePageEndIndex = recValuePageStartIndex + REC_VALUE_PAGE_SIZE;
  const visibleRecValueRows = useMemo(
    () => recValueRows.slice(recValuePageStartIndex, recValuePageEndIndex),
    [recValueRows, recValuePageStartIndex, recValuePageEndIndex],
  );

  return (
    <div className="space-y-4 mt-4">
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Part II Systems with Value Data</CardDescription>
            <CardTitle className="text-2xl">{formatNumber(recValueRows.length)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Total Contracted Value (Part II Verified)</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(snapshotPart2ValueSummary.totalContractedValue)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Value Gap (Contracted - Delivered)</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(snapshotPart2ValueSummary.totalGap)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Contract Value Reporting %</CardDescription>
            <CardTitle className="text-2xl">
              {formatPercent(snapshotPart2ValueSummary.contractedValueReportingPercent)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Contracted vs Delivered Value by Reporting Status
            </CardTitle>
            <CardDescription>
              Part II verified systems grouped into Reporting, Not Reporting, and
              Terminated.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72 rounded-md border border-slate-200 bg-white p-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={recValueByStatusChartRows}
                  margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      formatCurrency(value),
                      name,
                    ]}
                  />
                  <Legend />
                  <Bar dataKey="contractedValue" fill="#0ea5e9" name="Contracted Value" />
                  <Bar dataKey="deliveredValue" fill="#16a34a" name="Delivered Value" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top Value Gaps by System</CardTitle>
            <CardDescription>
              Largest contracted-vs-delivered dollar gaps across Part II verified systems.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72 rounded-md border border-slate-200 bg-white p-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={recTopGapChartRows}
                  margin={{ top: 8, right: 12, left: 4, bottom: 56 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="label"
                    angle={-35}
                    textAnchor="end"
                    interval={0}
                    height={72}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(value: number) => [formatCurrency(value), "Value Gap"]}
                  />
                  <Bar dataKey="valueGap" fill="#f59e0b" name="Value Gap" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">REC Value by System</CardTitle>
          <CardDescription>
            Compares delivered value vs contracted value at system REC price.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>
              Showing {formatNumber(visibleRecValueRows.length)} of{" "}
              {formatNumber(recValueRows.length)} rows
            </span>
            <span>
              Page {formatNumber(recValueCurrentPage)} of{" "}
              {formatNumber(recValueTotalPages)}
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>System</TableHead>
                <TableHead>Tracking ID</TableHead>
                <TableHead>REC Price</TableHead>
                <TableHead>Contracted RECs</TableHead>
                <TableHead>Delivered RECs</TableHead>
                <TableHead>% Delivered RECs</TableHead>
                <TableHead>Contracted Value</TableHead>
                <TableHead>Delivered Value</TableHead>
                <TableHead>% Delivered Value</TableHead>
                <TableHead>Gap</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRecValueRows.map((system) => (
                <TableRow key={system.key}>
                  <TableCell className="font-medium">{system.systemName}</TableCell>
                  <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                  <TableCell>{formatCurrency(system.recPrice)}</TableCell>
                  <TableCell>{formatNumber(system.contractedRecs)}</TableCell>
                  <TableCell>{formatNumber(system.deliveredRecs)}</TableCell>
                  <TableCell>
                    {formatPercent(
                      toPercentValue(system.deliveredRecs ?? 0, system.contractedRecs ?? 0),
                    )}
                  </TableCell>
                  <TableCell>
                    {formatCurrency(resolveContractValueAmount(system))}
                  </TableCell>
                  <TableCell>{formatCurrency(system.deliveredValue)}</TableCell>
                  <TableCell>
                    {formatPercent(
                      toPercentValue(
                        system.deliveredValue ?? 0,
                        resolveContractValueAmount(system),
                      ),
                    )}
                  </TableCell>
                  <TableCell
                    className={resolveValueGapAmount(system) > 0 ? "text-amber-700" : ""}
                  >
                    {formatCurrency(resolveValueGapAmount(system))}
                  </TableCell>
                </TableRow>
              ))}
              {visibleRecValueRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-6 text-center text-slate-500">
                    No systems with REC value data available.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRecValuePage((page) => Math.max(1, page - 1))}
              disabled={recValueCurrentPage <= 1}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setRecValuePage((page) => Math.min(recValueTotalPages, page + 1))
              }
              disabled={recValueCurrentPage >= recValueTotalPages}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
