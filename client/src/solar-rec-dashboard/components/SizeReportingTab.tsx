/**
 * Size + Reporting tab.
 *
 * Extracted from SolarRecDashboard.tsx (Phase 8) and further cleaned
 * up in Phase 12 to absorb the tab-specific `sizeTabNotReportingPart2Rows`
 * memo from the parent. Now owns:
 *   - 2 useStates (sizeSiteListPage, sizeSiteListCollapsed)
 *   - 2 useMemos (sizeTabNotReportingPart2Rows — the sorted
 *     non-reporting Part II list; and visibleSizeSiteListRows —
 *     pagination slice)
 *   - 1 callback (downloadSizeSiteListCsv)
 *
 * Receives:
 *   - `sizeBreakdownRows` from the parent (shared with Overview tab
 *     via sizeReportingChartRows).
 *   - `part2EligibleSystemsForSizeReporting` from the parent (one
 *     of the foundation memos — shared across many tabs).
 */

import { memo, useMemo, useState } from "react";
import { AskAiPanel } from "@/components/AskAiPanel";
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
  buildCsv,
  triggerCsvDownload,
  timestampForCsvFileName,
} from "@/solar-rec-dashboard/lib/csvIo";
import {
  formatDate,
  formatNumber,
} from "@/solar-rec-dashboard/lib/helpers";
import { SIZE_SITE_LIST_PAGE_SIZE } from "@/solar-rec-dashboard/lib/constants";
import type { SizeBucket, SystemRecord } from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type SizeBreakdownRow = {
  bucket: SizeBucket;
  total: number;
  reporting: number;
  notReporting: number;
  reportingPercent: number | null;
  contractedValue: number;
  deliveredValue: number;
  valueDeliveredPercent: number | null;
};

export interface SizeReportingTabProps {
  /** Per-size-bucket totals (parent's `sizeBreakdownRows` memo). */
  sizeBreakdownRows: SizeBreakdownRow[];
  /**
   * The Part II verified, scoped systems slice. Input for the
   * non-reporting site list below. Parent stays the single source
   * of truth for the scoped list; this tab filters/sorts from it.
   */
  part2EligibleSystemsForSizeReporting: SystemRecord[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function SizeReportingTab(props: SizeReportingTabProps) {
  const { sizeBreakdownRows, part2EligibleSystemsForSizeReporting } = props;

  const [sizeSiteListPage, setSizeSiteListPage] = useState(1);
  const [sizeSiteListCollapsed, setSizeSiteListCollapsed] = useState(false);

  const sizeTabNotReportingPart2Rows = useMemo(
    () =>
      part2EligibleSystemsForSizeReporting
        .filter((system) => !system.isReporting)
        .sort((a, b) =>
          a.systemName.localeCompare(b.systemName, undefined, {
            sensitivity: "base",
            numeric: true,
          }),
        ),
    [part2EligibleSystemsForSizeReporting],
  );

  const sizeSiteListTotalPages = Math.max(
    1,
    Math.ceil(sizeTabNotReportingPart2Rows.length / SIZE_SITE_LIST_PAGE_SIZE),
  );
  const sizeSiteListCurrentPage = Math.min(sizeSiteListPage, sizeSiteListTotalPages);
  const sizeSiteListPageStartIndex =
    (sizeSiteListCurrentPage - 1) * SIZE_SITE_LIST_PAGE_SIZE;
  const sizeSiteListPageEndIndex =
    sizeSiteListPageStartIndex + SIZE_SITE_LIST_PAGE_SIZE;
  const visibleSizeSiteListRows = useMemo(
    () =>
      sizeTabNotReportingPart2Rows.slice(
        sizeSiteListPageStartIndex,
        sizeSiteListPageEndIndex,
      ),
    [
      sizeTabNotReportingPart2Rows,
      sizeSiteListPageStartIndex,
      sizeSiteListPageEndIndex,
    ],
  );

  const downloadSizeSiteListCsv = () => {
    const headers = [
      "system_name",
      "tracking_id",
      "portal_id",
      "state_certification_number",
      "size_bucket",
      "system_size_kw_ac",
      "last_reporting_date",
    ];

    const rows = sizeTabNotReportingPart2Rows.map((system) => ({
      system_name: system.systemName,
      tracking_id: system.trackingSystemRefId ?? "",
      portal_id: system.systemId ?? "",
      state_certification_number: system.stateApplicationRefId ?? "",
      size_bucket: system.sizeBucket,
      system_size_kw_ac: system.installedKwAc ?? "",
      last_reporting_date: system.latestReportingDate
        ? system.latestReportingDate.toISOString().slice(0, 10)
        : "",
    }));

    const csv = buildCsv(headers, rows);
    triggerCsvDownload(`size-reporting-sites-${timestampForCsvFileName()}.csv`, csv);
  };

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Size Bucket Reporting Matrix</CardTitle>
          <CardDescription>
            Reporting is based on the most recent generation month being within the
            last 3 months.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Size Bucket</TableHead>
                <TableHead>Total Systems</TableHead>
                <TableHead>Reporting</TableHead>
                <TableHead>Not Reporting</TableHead>
                <TableHead>Reporting %</TableHead>
                <TableHead>Contracted Value</TableHead>
                <TableHead>Delivered Value</TableHead>
                <TableHead>Value Delivered %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sizeBreakdownRows.map((row) => (
                <TableRow key={row.bucket}>
                  <TableCell className="font-medium">{row.bucket}</TableCell>
                  <TableCell>{formatNumber(row.total)}</TableCell>
                  <TableCell>{formatNumber(row.reporting)}</TableCell>
                  <TableCell>{formatNumber(row.notReporting)}</TableCell>
                  <TableCell>{formatPercent(row.reportingPercent)}</TableCell>
                  <TableCell>{formatCurrency(row.contractedValue)}</TableCell>
                  <TableCell>{formatCurrency(row.deliveredValue)}</TableCell>
                  <TableCell>{formatPercent(row.valueDeliveredPercent)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">
                Systems Not Reporting in Last 3 Months
              </CardTitle>
              <CardDescription>Part II verified systems only.</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={downloadSizeSiteListCsv}>
                Download Site List CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSizeSiteListCollapsed((value) => !value)}
              >
                {sizeSiteListCollapsed ? "Expand List" : "Collapse List"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex items-center justify-between text-xs text-slate-600">
            <span>
              Showing {formatNumber(visibleSizeSiteListRows.length)} of{" "}
              {formatNumber(sizeTabNotReportingPart2Rows.length)} systems
            </span>
            {!sizeSiteListCollapsed ? (
              <span>
                Page {formatNumber(sizeSiteListCurrentPage)} of{" "}
                {formatNumber(sizeSiteListTotalPages)}
              </span>
            ) : null}
          </div>
          {sizeSiteListCollapsed ? (
            <p className="text-sm text-slate-600">
              Site list is collapsed. Click <strong>Expand List</strong> to view rows.
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>System</TableHead>
                    <TableHead>Tracking ID</TableHead>
                    <TableHead>Portal ID</TableHead>
                    <TableHead>State Certification #</TableHead>
                    <TableHead>Size Bucket</TableHead>
                    <TableHead>System Size (kW AC)</TableHead>
                    <TableHead>Last Reporting Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleSizeSiteListRows.map((system) => (
                    <TableRow key={system.key}>
                      <TableCell className="font-medium">{system.systemName}</TableCell>
                      <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                      <TableCell>{system.systemId ?? "N/A"}</TableCell>
                      <TableCell>{system.stateApplicationRefId ?? "N/A"}</TableCell>
                      <TableCell>{system.sizeBucket}</TableCell>
                      <TableCell>
                        {system.installedKwAc === null
                          ? "N/A"
                          : formatNumber(system.installedKwAc, 3)}
                      </TableCell>
                      <TableCell>{formatDate(system.latestReportingDate)}</TableCell>
                    </TableRow>
                  ))}
                  {visibleSizeSiteListRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-6 text-center text-slate-500">
                        No Part II verified non-reporting systems found.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
              <div className="mt-3 flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSizeSiteListPage((page) => Math.max(1, page - 1))}
                  disabled={sizeSiteListCurrentPage <= 1}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSizeSiteListPage((page) =>
                      Math.min(sizeSiteListTotalPages, page + 1),
                    )
                  }
                  disabled={sizeSiteListCurrentPage >= sizeSiteListTotalPages}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AskAiPanel
        moduleKey="solar-rec-size-reporting"
        title="Ask AI about size + reporting"
        contextGetter={() => ({
          sizeBuckets: sizeBreakdownRows,
          part2EligibleSystems: {
            total: part2EligibleSystemsForSizeReporting.length,
            reporting: part2EligibleSystemsForSizeReporting.filter(
              (s) => s.isReporting
            ).length,
            notReporting: sizeTabNotReportingPart2Rows.length,
          },
          sampleNotReportingSites: sizeTabNotReportingPart2Rows
            .slice(0, 20)
            .map((s) => ({
              systemName: s.systemName,
              trackingSystemRefId: s.trackingSystemRefId,
              installedKwAc: s.installedKwAc,
              installedKwDc: s.installedKwDc,
              sizeBucket: s.sizeBucket,
              monitoringPlatform: s.monitoringPlatform,
            })),
        })}
      />
    </div>
  );
});
