/**
 * System Detail Sheet.
 *
 * Extracted from `SolarRecDashboard.tsx` in Phase 11. Pure reader
 * component: receives the selected key and renders a right-side
 * sheet with identifiers, REC contract, status, system details,
 * and a server-driven "Recent Meter Reads" table at the bottom.
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
 *
 * Phase 2 PR-F-4-a (2026-05-06) — the Sheet no longer receives
 * the parent's legacy `SystemRecord[]` snapshot. It fetches the
 * selected row by primary key from `solarRecDashboardSystemFacts`
 * via `getSystemFactsBySystemKeys`, so opening the sheet does not
 * re-enable the 26 MB `getSystemSnapshot` response.
 */

import { useMemo } from "react";
import type { inferRouterOutputs } from "@trpc/server";
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
import type { SolarRecAppRouter } from "@server/_core/solarRecRouter";

type RouterOutputs = inferRouterOutputs<SolarRecAppRouter>;
type SystemFactsByKeysOutput =
  RouterOutputs["solarRecDashboard"]["getSystemFactsBySystemKeys"];
type SystemFactRow = SystemFactsByKeysOutput["rows"][number];

interface DetailSystem {
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
  systemName: string;
  recPrice: number | null;
  contractedRecs: number | null;
  deliveredRecs: number | null;
  contractedValue: number | null;
  deliveredValue: number | null;
  valueGap: number | null;
  latestReportingDate: Date | null;
  isReporting: boolean;
  ownershipStatus: string;
  contractStatusText: string;
  installedKwAc: number | null;
  installedKwDc: number | null;
  monitoringPlatform: string;
  monitoringType: string;
  installerName: string;
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = ymd
    ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeSystemFact(row: SystemFactRow): DetailSystem {
  return {
    systemId: row.systemId,
    stateApplicationRefId: row.stateApplicationRefId,
    trackingSystemRefId: row.trackingSystemRefId,
    systemName: row.systemName,
    recPrice: toNullableNumber(row.recPrice),
    contractedRecs: toNullableNumber(row.contractedRecs),
    deliveredRecs: toNullableNumber(row.deliveredRecs),
    contractedValue: toNullableNumber(row.contractedValue),
    deliveredValue: toNullableNumber(row.deliveredValue),
    valueGap: toNullableNumber(row.valueGap),
    latestReportingDate: toNullableDate(row.latestReportingDate),
    isReporting: row.isReporting,
    ownershipStatus: row.ownershipStatus,
    contractStatusText: row.contractStatusText,
    installedKwAc: toNullableNumber(row.installedKwAc),
    installedKwDc: toNullableNumber(row.installedKwDc),
    monitoringPlatform: row.monitoringPlatform,
    monitoringType: row.monitoringType,
    installerName: row.installerName,
  };
}

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
}

export default function SystemDetailSheet(props: SystemDetailSheetProps) {
  const { selectedSystemKey, onClose } = props;

  const systemFactsQuery =
    solarRecTrpc.solarRecDashboard.getSystemFactsBySystemKeys.useQuery(
      {
        systemKeys: selectedSystemKey === null ? [] : [selectedSystemKey],
      },
      {
        enabled: selectedSystemKey !== null,
        staleTime: 5 * 60_000,
        refetchOnWindowFocus: false,
      }
    );

  const sys = useMemo(() => {
    if (selectedSystemKey === null) return null;
    const row =
      systemFactsQuery.data?.rows.find(
        (candidate) => candidate.systemKey === selectedSystemKey
      ) ?? null;
    return row === null ? null : normalizeSystemFact(row);
  }, [selectedSystemKey, systemFactsQuery.data]);

  const isSystemDetailLoading =
    selectedSystemKey !== null &&
    (systemFactsQuery.isLoading ||
      (systemFactsQuery.isFetching && systemFactsQuery.data === undefined));

  const isSystemDetailError =
    selectedSystemKey !== null && systemFactsQuery.isError;

  const isSystemDetailMissing =
    selectedSystemKey !== null &&
    !isSystemDetailLoading &&
    !isSystemDetailError &&
    sys === null;

  const canLoadRecentReads = sys !== null;

  const recentReadsQuery =
    solarRecTrpc.solarRecDashboard.getSystemRecentMeterReads.useQuery(
      {
        systemId: sys?.systemId ?? null,
        systemName: sys?.systemName ?? "",
        limit: 20,
      },
      {
        enabled: canLoadRecentReads,
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
          if (isSystemDetailLoading)
            return (
              <p className="text-sm text-slate-500 mt-4">
                Loading system details...
              </p>
            );
          if (isSystemDetailError)
            return (
              <p className="text-sm text-rose-600 mt-4">
                Unable to load system details.
              </p>
            );
          if (isSystemDetailMissing)
            return (
              <p className="text-sm text-slate-500 mt-4">System not found.</p>
            );
          if (!sys) return null;

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
