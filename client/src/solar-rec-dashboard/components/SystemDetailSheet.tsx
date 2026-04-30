/**
 * System Detail Sheet.
 *
 * Extracted from `SolarRecDashboard.tsx` in Phase 11. Pure reader
 * component: receives the selected key + the parent's systems
 * array and renders a right-side sheet with identifiers, REC
 * contract, status, system details, and a server-driven "Recent
 * Meter Reads" table at the bottom.
 *
 * The `selectedSystemKey` state stays in the parent because
 * ANY tab can open the sheet — the parent still owns
 * `setSelectedSystemKey` and passes it down as `onSelectSystem`.
 *
 * Phase 5e Followup #4 step 2 (2026-04-29) — the prior
 * `convertedReads: CsvDataset | null` prop is gone. The Sheet
 * now fetches the per-system meter-reads slice via
 * `getSystemRecentMeterReads(systemId, systemName)`, which hits
 * the `(scopeId, monitoringSystemId, readDate)` index on
 * `srDsConvertedReads` and returns ≤20 rows (~1 KB) instead of
 * forcing the parent to hydrate the full 50–150 MB convertedReads
 * blob into memory. Removes the last in-component reader of
 * `datasets.convertedReads.rows` in the dashboard tree (the
 * remaining tab-priority hydration of `convertedReads` will be
 * dropped in a follow-up PR once this lands).
 */

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatCapacityKw,
  formatNumber,
} from "@/solar-rec-dashboard/lib/helpers";
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
import type { SystemRecord } from "@/solar-rec-dashboard/state/types";

export interface SystemDetailSheetProps {
  /**
   * The currently-selected system's `key`, or `null` when the
   * sheet is closed. Controlled by the parent.
   */
  selectedSystemKey: string | null;
  /**
   * Setter called when the sheet should close (either the user
   * clicks outside, presses Escape, or hits the close button).
   * The parent's state owner calls `setSelectedSystemKey(null)`.
   */
  onClose: () => void;
  /** All parent-known systems. Sheet looks up the selected one by key. */
  systems: SystemRecord[];
}

export default function SystemDetailSheet(props: SystemDetailSheetProps) {
  const { selectedSystemKey, onClose, systems } = props;

  const sys = useMemo(
    () =>
      selectedSystemKey === null
        ? null
        : systems.find((s) => s.key === selectedSystemKey) ?? null,
    [selectedSystemKey, systems]
  );

  const recentReadsQuery =
    solarRecTrpc.solarRecDashboard.getSystemRecentMeterReads.useQuery(
      {
        systemId: sys?.systemId ?? null,
        systemName: sys?.systemName ?? "",
        limit: 20,
      },
      {
        enabled: sys !== null,
        // Most recent reads can shift by the day on populated scopes;
        // 5-min stale window keeps re-opens snappy without hiding new
        // data. The underlying SELECT is sub-ms via the
        // (scopeId, monitoringSystemId, readDate) index.
        staleTime: 5 * 60_000,
        refetchOnWindowFocus: false,
      }
    );
  const sysReads = recentReadsQuery.data?.reads ?? [];

  return (
    <Sheet
      open={selectedSystemKey !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base">System Details</SheetTitle>
          <SheetDescription>Full details for the selected system.</SheetDescription>
        </SheetHeader>
        {(() => {
          if (!sys)
            return (
              <p className="text-sm text-slate-500 mt-4">System not found.</p>
            );

          return (
            <div className="space-y-4 mt-4">
              {/* Identifiers */}
              <div className="space-y-1">
                <h4 className="text-xs font-semibold uppercase text-slate-500">
                  Identifiers
                </h4>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <span className="text-slate-500">Name</span>
                  <span className="font-medium">{sys.systemName}</span>
                  {sys.systemId && (
                    <>
                      <span className="text-slate-500">System ID</span>
                      <span className="font-medium">{sys.systemId}</span>
                    </>
                  )}
                  {sys.trackingSystemRefId && (
                    <>
                      <span className="text-slate-500">Tracking ID</span>
                      <span className="font-medium">{sys.trackingSystemRefId}</span>
                    </>
                  )}
                  {sys.stateApplicationRefId && (
                    <>
                      <span className="text-slate-500">App Ref ID</span>
                      <span className="font-medium">{sys.stateApplicationRefId}</span>
                    </>
                  )}
                </div>
              </div>

              {/* REC Contract */}
              <div className="space-y-1">
                <h4 className="text-xs font-semibold uppercase text-slate-500">
                  REC Contract
                </h4>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <span className="text-slate-500">REC Price</span>
                  <span className="font-medium">
                    {sys.recPrice !== null ? `$${sys.recPrice}` : "N/A"}
                  </span>
                  <span className="text-slate-500">Contracted RECs</span>
                  <span className="font-medium">
                    {formatNumber(sys.contractedRecs)}
                  </span>
                  <span className="text-slate-500">Delivered RECs</span>
                  <span className="font-medium">
                    {formatNumber(sys.deliveredRecs)}
                  </span>
                  <span className="text-slate-500">Contracted Value</span>
                  <span className="font-medium">
                    {sys.contractedValue !== null
                      ? `$${formatNumber(sys.contractedValue)}`
                      : "N/A"}
                  </span>
                  <span className="text-slate-500">Delivered Value</span>
                  <span className="font-medium">
                    {sys.deliveredValue !== null
                      ? `$${formatNumber(sys.deliveredValue)}`
                      : "N/A"}
                  </span>
                  <span className="text-slate-500">Value Gap</span>
                  <span
                    className={`font-medium ${
                      (sys.valueGap ?? 0) > 0 ? "text-rose-600" : "text-emerald-600"
                    }`}
                  >
                    {sys.valueGap !== null
                      ? `$${formatNumber(sys.valueGap)}`
                      : "N/A"}
                  </span>
                </div>
              </div>

              {/* Status */}
              <div className="space-y-1">
                <h4 className="text-xs font-semibold uppercase text-slate-500">
                  Status
                </h4>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <span className="text-slate-500">Reporting</span>
                  <span>
                    <Badge variant={sys.isReporting ? "default" : "destructive"}>
                      {sys.isReporting ? "Yes" : "No"}
                    </Badge>
                  </span>
                  <span className="text-slate-500">Last Reported</span>
                  <span className="font-medium">
                    {sys.latestReportingDate?.toLocaleDateString() ?? "Never"}
                  </span>
                  <span className="text-slate-500">Ownership</span>
                  <span>
                    <Badge variant="outline">{sys.ownershipStatus}</Badge>
                  </span>
                  <span className="text-slate-500">Contract Status</span>
                  <span className="font-medium">
                    {sys.contractStatusText || "N/A"}
                  </span>
                </div>
              </div>

              {/* System Details */}
              <div className="space-y-1">
                <h4 className="text-xs font-semibold uppercase text-slate-500">
                  System
                </h4>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <span className="text-slate-500">Size (AC)</span>
                  <span className="font-medium">
                    {sys.installedKwAc !== null
                      ? `${formatCapacityKw(sys.installedKwAc)} kW`
                      : "N/A"}
                  </span>
                  <span className="text-slate-500">Size (DC)</span>
                  <span className="font-medium">
                    {sys.installedKwDc !== null
                      ? `${formatCapacityKw(sys.installedKwDc)} kW`
                      : "N/A"}
                  </span>
                  <span className="text-slate-500">Monitoring</span>
                  <span className="font-medium">
                    {sys.monitoringPlatform || "N/A"}
                  </span>
                  <span className="text-slate-500">Type</span>
                  <span className="font-medium">{sys.monitoringType || "N/A"}</span>
                  <span className="text-slate-500">Installer</span>
                  <span className="font-medium">{sys.installerName || "N/A"}</span>
                </div>
              </div>

              {/* Recent Converted Reads */}
              {sysReads.length > 0 && (
                <div className="space-y-1">
                  <h4 className="text-xs font-semibold uppercase text-slate-500">
                    Recent Meter Reads ({sysReads.length})
                  </h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Date</TableHead>
                        <TableHead className="text-xs">Platform</TableHead>
                        <TableHead className="text-xs text-right">
                          Lifetime (Wh)
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sysReads.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{r.readDate}</TableCell>
                          <TableCell className="text-xs">
                            {r.monitoring ?? ""}
                          </TableCell>
                          <TableCell className="text-xs text-right">
                            {formatNumber(r.lifetimeMeterReadWh ?? 0)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          );
        })()}
      </SheetContent>
    </Sheet>
  );
}
