/**
 * Overview tab.
 *
 * Extracted from SolarRecDashboard.tsx (Phase 8) and further cleaned
 * up in Phase 12 to absorb 3 tab-specific memos from the parent:
 * `overviewPart2Totals`, `sizeReportingChartRows`, and
 * `ownershipStackedChartRows`. All three were single-consumer feeds
 * that are now computed locally from shared foundation memos.
 *
 * State + memos:
 *   - No useState (tab is still a pure reader)
 *   - 3 useMemos — the 3 memos pulled down from the parent
 *
 * Props: foundation memos (shared with other tabs) + computed
 * summaries that `createLogEntry` still reads.
 */

import { memo, useMemo } from "react";
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
import { clean, formatCurrency, formatPercent } from "@/lib/helpers";
import {
  formatCapacityKw,
  formatNumber,
  resolveContractValueAmount,
  resolvePart2ProjectIdentity,
} from "@/solar-rec-dashboard/lib/helpers";
import type {
  ChangeOwnershipStatus,
  ChangeOwnershipSummary,
  CsvRow,
  FinancialProfitData,
  SizeBucket,
  SystemRecord,
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

/** One row in the parent's `sizeBreakdownRows` memo. Structural only. */
export type OverviewSizeBreakdownRow = {
  bucket: SizeBucket;
  reporting: number;
  notReporting: number;
};

export interface OverviewTabProps {
  summary: OverviewSummary;
  financialProfitData: FinancialProfitData;
  changeOwnershipSummary: ChangeOwnershipSummary;
  /**
   * Foundation memo from the parent — the Part II verified,
   * scoped systems slice. Used for the Part II KPI totals and
   * the stacked ownership chart.
   */
  part2EligibleSystemsForSizeReporting: SystemRecord[];
  /**
   * Parent's `sizeBreakdownRows` memo. Shared with SizeReportingTab;
   * Overview maps it into the compact reporting chart shape.
   */
  sizeBreakdownRows: OverviewSizeBreakdownRow[];
  /** Foundation memo — shared by many tabs. */
  part2VerifiedAbpRows: CsvRow[];
  /** Foundation memo — the 440-line parent `systems` list. */
  systems: SystemRecord[];
  onDownloadOwnershipTile: (tile: "reporting" | "notReporting" | "terminated") => void;
  onDownloadChangeOwnershipTile: (status: ChangeOwnershipStatus) => void;
  onJumpToOfflineMonitoring: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function OverviewTab(props: OverviewTabProps) {
  const {
    summary,
    financialProfitData,
    changeOwnershipSummary,
    part2EligibleSystemsForSizeReporting,
    sizeBreakdownRows,
    part2VerifiedAbpRows,
    systems,
    onDownloadOwnershipTile,
    onDownloadChangeOwnershipTile,
    onJumpToOfflineMonitoring,
  } = props;

  // Part II verified KPI totals: contracted value + cumulative
  // installed kW AC/DC across the scoped systems. Used for Row 2
  // of the KPI grid.
  const overviewPart2Totals = useMemo(() => {
    let totalContractedValuePart2 = 0;
    let cumulativeKwAcPart2 = 0;
    let cumulativeKwDcPart2 = 0;
    for (const system of part2EligibleSystemsForSizeReporting) {
      totalContractedValuePart2 += resolveContractValueAmount(system);
      cumulativeKwAcPart2 += system.installedKwAc ?? 0;
      cumulativeKwDcPart2 += system.installedKwDc ?? 0;
    }
    return {
      totalContractedValuePart2,
      cumulativeKwAcPart2,
      cumulativeKwDcPart2,
    };
  }, [part2EligibleSystemsForSizeReporting]);

  // Compact projection of sizeBreakdownRows for the stacked
  // reporting-by-size bar chart.
  const sizeReportingChartRows = useMemo(
    () =>
      sizeBreakdownRows.map((row) => ({
        bucket: row.bucket,
        reporting: row.reporting,
        notReporting: row.notReporting,
      })),
    [sizeBreakdownRows],
  );

  // Stacked "Ownership Mix by Reporting State" chart — walks the
  // Part II verified AbpReport rows, matches them to the parent's
  // systems list via four indexed maps, and buckets each matched
  // system into NotTransferred / Transferred / ChangeOwnership
  // under Reporting vs Not Reporting.
  const ownershipStackedChartRows = useMemo(() => {
    const eligiblePart2ApplicationIds = new Set<string>();
    const eligiblePart2PortalSystemIds = new Set<string>();
    const eligiblePart2TrackingIds = new Set<string>();
    part2VerifiedAbpRows.forEach((row) => {
      const applicationId = clean(row.Application_ID);
      const portalSystemId = clean(row.system_id);
      const trackingId =
        clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) ||
        clean(row.tracking_system_ref_id);
      if (applicationId) eligiblePart2ApplicationIds.add(applicationId);
      if (portalSystemId) eligiblePart2PortalSystemIds.add(portalSystemId);
      if (trackingId) eligiblePart2TrackingIds.add(trackingId);
    });

    const scopedPart2Systems = systems.filter((system) => {
      const byPortalSystemId = system.systemId
        ? eligiblePart2PortalSystemIds.has(system.systemId)
        : false;
      const byApplicationId = system.stateApplicationRefId
        ? eligiblePart2ApplicationIds.has(system.stateApplicationRefId)
        : false;
      const byTrackingId = system.trackingSystemRefId
        ? eligiblePart2TrackingIds.has(system.trackingSystemRefId)
        : false;
      return byPortalSystemId || byApplicationId || byTrackingId;
    });

    const systemsById = new Map<string, SystemRecord[]>();
    const systemsByApplicationId = new Map<string, SystemRecord[]>();
    const systemsByTrackingId = new Map<string, SystemRecord[]>();
    const systemsByName = new Map<string, SystemRecord[]>();

    const addIndexedSystem = (
      map: Map<string, SystemRecord[]>,
      key: string | null | undefined,
      system: SystemRecord,
    ) => {
      const normalized = clean(key);
      if (!normalized) return;
      const existing = map.get(normalized) ?? [];
      existing.push(system);
      map.set(normalized, existing);
    };

    scopedPart2Systems.forEach((system) => {
      addIndexedSystem(systemsById, system.systemId, system);
      addIndexedSystem(systemsByApplicationId, system.stateApplicationRefId, system);
      addIndexedSystem(systemsByTrackingId, system.trackingSystemRefId, system);
      addIndexedSystem(systemsByName, system.systemName.toLowerCase(), system);
    });

    const rows = [
      { label: "Reporting", notTransferred: 0, transferred: 0, changeOwnership: 0 },
      { label: "Not Reporting", notTransferred: 0, transferred: 0, changeOwnership: 0 },
    ];

    const uniquePart2Projects = new Set<string>();

    part2VerifiedAbpRows.forEach((row, index) => {
      const { applicationId, portalSystemId, trackingId, projectNameKey, dedupeKey } =
        resolvePart2ProjectIdentity(row, index);
      if (uniquePart2Projects.has(dedupeKey)) return;
      uniquePart2Projects.add(dedupeKey);

      const matchedSystems = new Map<string, SystemRecord>();
      (systemsById.get(portalSystemId) ?? []).forEach((system) =>
        matchedSystems.set(system.key, system),
      );
      (systemsByApplicationId.get(applicationId) ?? []).forEach((system) =>
        matchedSystems.set(system.key, system),
      );
      (systemsByTrackingId.get(trackingId) ?? []).forEach((system) =>
        matchedSystems.set(system.key, system),
      );
      (systemsByName.get(projectNameKey) ?? []).forEach((system) =>
        matchedSystems.set(system.key, system),
      );

      if (matchedSystems.size === 0) {
        rows[1]!.notTransferred += 1;
        return;
      }

      let isReporting = false;
      let isTransferred = false;
      let isTerminated = false;
      let isChangeOwnershipNotTransferred = false;

      matchedSystems.forEach((system) => {
        if (system.isReporting) isReporting = true;
        if (system.isTransferred) isTransferred = true;
        if (system.isTerminated) isTerminated = true;
        const normalizedChangeOwnershipStatus = clean(system.changeOwnershipStatus ?? "");
        if (normalizedChangeOwnershipStatus.startsWith("Change of Ownership - Not Transferred")) {
          isChangeOwnershipNotTransferred = true;
        }
      });

      if (isTerminated) return;

      const target = isReporting ? rows[0]! : rows[1]!;
      if (isChangeOwnershipNotTransferred) {
        target.changeOwnership += 1;
      } else if (isTransferred) {
        target.transferred += 1;
      } else {
        target.notTransferred += 1;
      }
    });

    return rows;
  }, [part2VerifiedAbpRows, systems]);

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
});
