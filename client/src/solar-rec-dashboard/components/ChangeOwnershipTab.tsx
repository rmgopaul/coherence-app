/**
 * Change Ownership tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 3 of the
 * god-component decomposition. Owns:
 *   - 4 useStates (filter, search, sortBy, sortDir)
 *   - 1 useMemo (filteredChangeOwnershipRows)
 *   - 1 CSV download callback
 *
 * Unlike Performance Ratio and Offline Monitoring, the upstream
 * `changeOwnershipRows` and `changeOwnershipSummary` memos stay in the
 * parent because Overview tab tiles, Snapshot Log, and createLogEntry
 * all read from them. This tab receives both as props.
 *
 * Component mounts only when `activeTab === "change-ownership"`, so the
 * filter/sort closure is garbage collected when the user switches away.
 */

import { useCallback, useMemo, useState } from "react";
import { formatCurrency, formatPercent } from "@/lib/helpers";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  changeOwnershipBadgeClass,
  formatCapacityKw,
  formatDate,
  formatNumber,
  resolveContractValueAmount,
} from "@/solar-rec-dashboard/lib/helpers";
import { CHANGE_OWNERSHIP_ORDER } from "@/solar-rec-dashboard/lib/constants";
import type {
  ChangeOwnershipStatus,
  ChangeOwnershipSummary,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ChangeOwnershipTabProps {
  /**
   * Flagged change-of-ownership systems. Computed by the parent's
   * `changeOwnershipRows` useMemo and also consumed by Overview +
   * Snapshot Log, so it stays in the parent.
   */
  changeOwnershipRows: SystemRecord[];

  /**
   * Aggregated counts + contract values by status. Computed by the
   * parent's `changeOwnershipSummary` useMemo. Also consumed by Overview
   * tiles, so stays in the parent.
   */
  changeOwnershipSummary: ChangeOwnershipSummary;
}

// ---------------------------------------------------------------------------
// Local sort-key type
// ---------------------------------------------------------------------------

type ChangeOwnershipSortKey =
  | "systemName"
  | "contractValue"
  | "installedKwAc"
  | "contractDate"
  | "zillowSoldDate"
  | "status"
  | "reporting";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ChangeOwnershipTab(props: ChangeOwnershipTabProps) {
  const { changeOwnershipRows, changeOwnershipSummary } = props;

  const [changeOwnershipFilter, setChangeOwnershipFilter] = useState<
    ChangeOwnershipStatus | "All"
  >("All");
  const [changeOwnershipSearch, setChangeOwnershipSearch] = useState("");
  const [changeOwnershipSortBy, setChangeOwnershipSortBy] =
    useState<ChangeOwnershipSortKey>("contractValue");
  const [changeOwnershipSortDir, setChangeOwnershipSortDir] = useState<
    "asc" | "desc"
  >("desc");

  // -------------------------------------------------------------------------
  // Filter + sort the upstream rows. Capped at 500 rows in the UI below
  // (the tab is an auditing surface, not a dense-table use case).
  // -------------------------------------------------------------------------
  const filteredChangeOwnershipRows = useMemo(() => {
    const normalizedSearch = changeOwnershipSearch.trim().toLowerCase();
    const rows = changeOwnershipRows.filter((system) => {
      const matchesFilter =
        changeOwnershipFilter === "All"
          ? true
          : system.changeOwnershipStatus === changeOwnershipFilter;
      if (!matchesFilter) return false;
      if (!normalizedSearch) return true;

      const haystack = [
        system.systemName,
        system.systemId ?? "",
        system.trackingSystemRefId ?? "",
        system.contractType ?? "",
        system.zillowStatus ?? "",
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });

    const direction = changeOwnershipSortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const byName =
        a.systemName.localeCompare(b.systemName, undefined, {
          sensitivity: "base",
          numeric: true,
        }) * direction;

      if (changeOwnershipSortBy === "systemName") return byName;
      if (changeOwnershipSortBy === "status") {
        const aStatus = a.changeOwnershipStatus ?? "";
        const bStatus = b.changeOwnershipStatus ?? "";
        const diff =
          aStatus.localeCompare(bStatus, undefined, {
            sensitivity: "base",
            numeric: true,
          }) * direction;
        return diff === 0 ? byName : diff;
      }
      if (changeOwnershipSortBy === "reporting") {
        const aValue = a.isReporting ? 1 : 0;
        const bValue = b.isReporting ? 1 : 0;
        if (aValue === bValue) return byName;
        return (aValue - bValue) * direction;
      }
      if (changeOwnershipSortBy === "contractValue") {
        const aValue = resolveContractValueAmount(a);
        const bValue = resolveContractValueAmount(b);
        if (aValue === bValue) return byName;
        return (aValue - bValue) * direction;
      }
      if (changeOwnershipSortBy === "installedKwAc") {
        const aValue = a.installedKwAc ?? Number.NEGATIVE_INFINITY;
        const bValue = b.installedKwAc ?? Number.NEGATIVE_INFINITY;
        if (aValue === bValue) return byName;
        return (aValue - bValue) * direction;
      }
      if (changeOwnershipSortBy === "contractDate") {
        const aValue = a.contractedDate?.getTime() ?? Number.NEGATIVE_INFINITY;
        const bValue = b.contractedDate?.getTime() ?? Number.NEGATIVE_INFINITY;
        if (aValue === bValue) return byName;
        return (aValue - bValue) * direction;
      }

      const aValue = a.zillowSoldDate?.getTime() ?? Number.NEGATIVE_INFINITY;
      const bValue = b.zillowSoldDate?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (aValue === bValue) return byName;
      return (aValue - bValue) * direction;
    });

    return rows;
  }, [
    changeOwnershipFilter,
    changeOwnershipRows,
    changeOwnershipSearch,
    changeOwnershipSortBy,
    changeOwnershipSortDir,
  ]);

  // -------------------------------------------------------------------------
  // Export the current filter+sort view as CSV.
  // -------------------------------------------------------------------------
  const downloadChangeOwnershipDetailFilteredCsv = useCallback(() => {
    if (filteredChangeOwnershipRows.length === 0) return;

    const headers = [
      "system_name",
      "system_id",
      "tracking_id",
      "ac_size_kw",
      "contract_value",
      "contract_date",
      "zillow_sold_date",
      "zillow_status",
      "contract_type",
      "status_category",
      "reporting",
    ];

    const rows = filteredChangeOwnershipRows.map((system) => ({
      system_name: system.systemName,
      system_id: system.systemId ?? "",
      tracking_id: system.trackingSystemRefId ?? "",
      ac_size_kw: system.installedKwAc ?? "",
      contract_value: resolveContractValueAmount(system),
      contract_date: system.contractedDate
        ? system.contractedDate.toISOString().slice(0, 10)
        : "",
      zillow_sold_date: system.zillowSoldDate
        ? system.zillowSoldDate.toISOString().slice(0, 10)
        : "",
      zillow_status: system.zillowStatus ?? "",
      contract_type: system.contractType ?? "",
      status_category: system.changeOwnershipStatus ?? "",
      reporting: system.isReporting ? "Yes" : "No",
    }));

    const csv = buildCsv(headers, rows);
    const fileName = `coo-flagged-systems-detail-${timestampForCsvFileName()}.csv`;
    triggerCsvDownload(fileName, csv);
  }, [filteredChangeOwnershipRows]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Change of Ownership Logic</CardTitle>
          <CardDescription>
            A system is flagged for COO when contract type is IL ABP -
            Transferred/Terminated, or when Zillow is Sold and sold date is
            after contract date.
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Flagged Change of Ownership Systems</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(changeOwnershipSummary.total)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Reporting (Last 3 Months)</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(changeOwnershipSummary.reporting)}
            </CardTitle>
            <CardDescription>
              {formatPercent(changeOwnershipSummary.reportingPercent)}
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Not Reporting (Last 3 Months)</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(changeOwnershipSummary.notReporting)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Contract Value (COO Total)</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(changeOwnershipSummary.contractedValueTotal)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Contract Value Reporting</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(changeOwnershipSummary.contractedValueReporting)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Contract Value Not Reporting</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(changeOwnershipSummary.contractedValueNotReporting)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status Breakdown</CardTitle>
          <CardDescription>
            Uses contract type for IL ABP Transferred/Terminated, otherwise
            marks as Change of Ownership - Not Transferred.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {changeOwnershipSummary.counts.map((item) => (
            <div
              key={item.status}
              className="rounded-lg border border-slate-200 p-3 bg-white"
            >
              <p className="text-xs text-slate-500">{item.status}</p>
              <p className="text-2xl font-semibold text-slate-900">
                {formatNumber(item.count)}
              </p>
              <p className="text-xs text-slate-500">
                {formatPercent(item.percent)}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <CardTitle className="text-base">Flagged Systems Detail</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadChangeOwnershipDetailFilteredCsv}
              disabled={filteredChangeOwnershipRows.length === 0}
            >
              Export Filtered Table CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Filter by status
              </label>
              <select
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={changeOwnershipFilter}
                onChange={(event) =>
                  setChangeOwnershipFilter(
                    event.target.value as ChangeOwnershipStatus | "All",
                  )
                }
              >
                <option value="All">All Categories</option>
                {CHANGE_OWNERSHIP_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Search</label>
              <Input
                placeholder="System name, IDs, contract type..."
                value={changeOwnershipSearch}
                onChange={(event) => setChangeOwnershipSearch(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Sort by
              </label>
              <select
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={changeOwnershipSortBy}
                onChange={(event) =>
                  setChangeOwnershipSortBy(
                    event.target.value as ChangeOwnershipSortKey,
                  )
                }
              >
                <option value="contractValue">Contract Value</option>
                <option value="installedKwAc">AC Size (kW)</option>
                <option value="contractDate">Contract Date</option>
                <option value="zillowSoldDate">Zillow Sold Date</option>
                <option value="status">Status Category</option>
                <option value="reporting">Reporting</option>
                <option value="systemName">System Name</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Direction
              </label>
              <select
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={changeOwnershipSortDir}
                onChange={(event) =>
                  setChangeOwnershipSortDir(event.target.value as "asc" | "desc")
                }
              >
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </div>
          </div>

          {filteredChangeOwnershipRows.length > 500 ? (
            <p className="text-xs text-slate-500">
              Showing first 500 of{" "}
              {formatNumber(filteredChangeOwnershipRows.length)} systems.
            </p>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>System</TableHead>
                <TableHead>system_id</TableHead>
                <TableHead>Tracking ID</TableHead>
                <TableHead>AC Size (kW)</TableHead>
                <TableHead>Contract Value</TableHead>
                <TableHead>Contract Date</TableHead>
                <TableHead>Zillow Sold Date</TableHead>
                <TableHead>Zillow Status</TableHead>
                <TableHead>Contract Type</TableHead>
                <TableHead>Status Category</TableHead>
                <TableHead>Reporting?</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredChangeOwnershipRows.slice(0, 500).map((system) => (
                <TableRow key={system.key}>
                  <TableCell className="font-medium">{system.systemName}</TableCell>
                  <TableCell>{system.systemId ?? "N/A"}</TableCell>
                  <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                  <TableCell>{formatCapacityKw(system.installedKwAc)}</TableCell>
                  <TableCell>
                    {formatCurrency(resolveContractValueAmount(system))}
                  </TableCell>
                  <TableCell>{formatDate(system.contractedDate)}</TableCell>
                  <TableCell>{formatDate(system.zillowSoldDate)}</TableCell>
                  <TableCell>{system.zillowStatus ?? "N/A"}</TableCell>
                  <TableCell>{system.contractType ?? "N/A"}</TableCell>
                  <TableCell>
                    {system.changeOwnershipStatus ? (
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium ${changeOwnershipBadgeClass(
                          system.changeOwnershipStatus,
                        )}`}
                      >
                        {system.changeOwnershipStatus}
                      </span>
                    ) : (
                      "N/A"
                    )}
                  </TableCell>
                  <TableCell>{system.isReporting ? "Yes" : "No"}</TableCell>
                </TableRow>
              ))}
              {filteredChangeOwnershipRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="py-6 text-center text-slate-500">
                    No flagged systems match the current filters.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
