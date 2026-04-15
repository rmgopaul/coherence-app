/**
 * Ownership Status tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 3 of the
 * god-component decomposition. Owns:
 *   - 2 useStates (ownershipFilter, searchTerm)
 *   - 1 useMemo (filteredOwnershipRows)
 *
 * Smaller than the other extracted tabs but still worth isolating:
 * it pulls the `searchTerm` useState out of the parent (it had a
 * generic name that was Ownership-tab-specific but the parent was
 * holding the state for no reason), and removes one useMemo + 75
 * lines of JSX from the parent's render cycle.
 *
 * Mounts only when `activeTab === "ownership"`.
 */

import { useDeferredValue, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  formatDate,
  ownershipBadgeClass,
} from "@/solar-rec-dashboard/lib/helpers";
import { OWNERSHIP_ORDER } from "@/solar-rec-dashboard/lib/constants";
import type {
  OwnershipStatus,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface OwnershipTabProps {
  /**
   * Part-2-verified systems eligible for the Ownership Status classifier.
   * Computed by the parent's `part2EligibleSystemsForSizeReporting` useMemo;
   * shared with many other tabs.
   */
  part2EligibleSystemsForSizeReporting: SystemRecord[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OwnershipTab(props: OwnershipTabProps) {
  const { part2EligibleSystemsForSizeReporting } = props;

  const [ownershipFilter, setOwnershipFilter] = useState<
    OwnershipStatus | "All"
  >("All");
  const [searchTerm, setSearchTerm] = useState("");
  // Phase 18: defer the search string so filteredOwnershipRows
  // re-runs as a low-priority update, keeping keystrokes responsive.
  const deferredSearchTerm = useDeferredValue(searchTerm);

  const filteredOwnershipRows = useMemo(() => {
    const normalizedSearch = deferredSearchTerm.trim().toLowerCase();
    return part2EligibleSystemsForSizeReporting.filter((system) => {
      const matchesFilter =
        ownershipFilter === "All" ? true : system.ownershipStatus === ownershipFilter;
      if (!matchesFilter) return false;
      if (!normalizedSearch) return true;

      const haystack = [
        system.systemName,
        system.systemId ?? "",
        system.trackingSystemRefId ?? "",
        system.contractStatusText,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }, [ownershipFilter, part2EligibleSystemsForSizeReporting, deferredSearchTerm]);

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ownership Status Classifier</CardTitle>
          <CardDescription>
            Categories: Transferred, Not Transferred, and Terminated crossed
            with Reporting / Not Reporting.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Filter by category
              </label>
              <select
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={ownershipFilter}
                onChange={(event) =>
                  setOwnershipFilter(event.target.value as OwnershipStatus | "All")
                }
              >
                <option value="All">All Categories</option>
                {OWNERSHIP_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Search</label>
              <Input
                placeholder="System name, system_id, tracking ID..."
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>System</TableHead>
                <TableHead>system_id</TableHead>
                <TableHead>Tracking ID</TableHead>
                <TableHead>Status Category</TableHead>
                <TableHead>Reporting?</TableHead>
                <TableHead>Transferred?</TableHead>
                <TableHead>Terminated?</TableHead>
                <TableHead>Contract Type</TableHead>
                <TableHead>Last Reporting Date</TableHead>
                <TableHead>Contracted Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredOwnershipRows.slice(0, 500).map((system) => (
                <TableRow key={system.key}>
                  <TableCell className="font-medium">{system.systemName}</TableCell>
                  <TableCell>{system.systemId ?? "N/A"}</TableCell>
                  <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium ${ownershipBadgeClass(
                        system.ownershipStatus,
                      )}`}
                    >
                      {system.ownershipStatus}
                    </span>
                  </TableCell>
                  <TableCell>{system.isReporting ? "Yes" : "No"}</TableCell>
                  <TableCell>{system.isTransferred ? "Yes" : "No"}</TableCell>
                  <TableCell>{system.isTerminated ? "Yes" : "No"}</TableCell>
                  <TableCell>{system.contractType ?? "N/A"}</TableCell>
                  <TableCell>{formatDate(system.latestReportingDate)}</TableCell>
                  <TableCell>{formatDate(system.contractedDate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
