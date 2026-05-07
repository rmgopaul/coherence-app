/**
 * Offline Monitoring tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14) as the second
 * tab extraction following PerformanceRatioTab. Owns:
 *   - 13 useStates (4 filters, 8 sort dir/by pairs, 1 pagination)
 *   - 10 useMemos (base systems, 3 dropdown option lists, 3 breakdown
 *     tables, filtered detail list, summary, zero-reporting table,
 *     visible pagination window)
 *   - 2 useEffects (filter reset → page 1, pagination clamping)
 *   - 2 CSV download callbacks
 *
 * Upstream computed data (part2EligibleSystemsForSizeReporting,
 * abpApplicationIdBySystemKey, monitoringDetailsBySystemKey) is
 * passed in via props — these lookups are shared with other tabs and
 * stay in the parent.
 *
 * The tab only mounts when `activeTab === "offline-monitoring"`, so
 * none of these memos run while the user is on any other tab.
 * Switching away unmounts the whole subtree.
 */

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AskAiPanel } from "@/components/AskAiPanel";
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
import { buildCsv, triggerCsvDownload } from "@/solar-rec-dashboard/lib/csvIo";
import {
  formatDate,
  formatKwh,
  formatNumber,
  getMonitoringDetailsForSystem,
  resolveContractValueAmount,
  resolveOfflineMonitoringAccessFields,
  toPercentValue,
} from "@/solar-rec-dashboard/lib/helpers";
import { OFFLINE_DETAIL_PAGE_SIZE } from "@/solar-rec-dashboard/lib/constants";
import type {
  MonitoringDetailsRecord,
  OfflineBreakdownRow,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
import { useDashboardBuildControl } from "@/solar-rec-dashboard/hooks/useDashboardBuildControl";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface OfflineMonitoringTabProps {
  // Upstream computed data (shared with other tabs; computed in parent)
  part2EligibleSystemsForSizeReporting: SystemRecord[];
  abpApplicationIdBySystemKey: Map<string, string>;
  monitoringDetailsBySystemKey: Map<string, MonitoringDetailsRecord>;

  // Scroll-to-anchor helper from parent (shared table-of-contents behavior)
  jumpToSection: (sectionId: string) => void;
}

// ---------------------------------------------------------------------------
// Local sort-key types — narrow unions used by the sort dropdowns
// ---------------------------------------------------------------------------

type BreakdownSortKey =
  | "offlineSystems"
  | "offlinePercent"
  | "offlineContractValue"
  | "label";

type OfflineDetailSortKey =
  | "systemName"
  | "monitoringType"
  | "monitoringPlatform"
  | "installerName"
  | "contractedValue"
  | "latestReportingDate";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function OfflineMonitoringTab(
  props: OfflineMonitoringTabProps,
) {
  const {
    part2EligibleSystemsForSizeReporting,
    abpApplicationIdBySystemKey,
    monitoringDetailsBySystemKey,
    jumpToSection,
  } = props;

  // --- Filter state ---
  const [offlineMonitoringFilter, setOfflineMonitoringFilter] = useState("All");
  const [offlinePlatformFilter, setOfflinePlatformFilter] = useState("All");
  const [offlineInstallerFilter, setOfflineInstallerFilter] = useState("All");
  const [offlineSearch, setOfflineSearch] = useState("");
  // Phase 18: defer the search string so filteredOfflineSystems
  // re-runs as a low-priority update, keeping keystrokes responsive.
  const deferredOfflineSearch = useDeferredValue(offlineSearch);

  // --- Breakdown table sort state (one per table) ---
  const [offlineMonitoringSortBy, setOfflineMonitoringSortBy] =
    useState<BreakdownSortKey>("offlineSystems");
  const [offlineMonitoringSortDir, setOfflineMonitoringSortDir] = useState<
    "asc" | "desc"
  >("desc");
  const [offlinePlatformSortBy, setOfflinePlatformSortBy] =
    useState<BreakdownSortKey>("offlineSystems");
  const [offlinePlatformSortDir, setOfflinePlatformSortDir] = useState<
    "asc" | "desc"
  >("desc");
  const [offlineInstallerSortBy, setOfflineInstallerSortBy] =
    useState<BreakdownSortKey>("offlineSystems");
  const [offlineInstallerSortDir, setOfflineInstallerSortDir] = useState<
    "asc" | "desc"
  >("desc");

  // --- Detail table sort + pagination ---
  const [offlineDetailSortBy, setOfflineDetailSortBy] =
    useState<OfflineDetailSortKey>("contractedValue");
  const [offlineDetailSortDir, setOfflineDetailSortDir] = useState<
    "asc" | "desc"
  >("desc");
  const [offlineDetailPage, setOfflineDetailPage] = useState(1);
  const utils = solarRecTrpc.useUtils();

  const refreshOfflineMonitoringRows = useCallback(() => {
    return Promise.all([
      utils.solarRecDashboard.getDashboardMonitoringDetailsPage.invalidate(),
      utils.solarRecDashboard.getDashboardSystemsPage.invalidate(),
    ]).then(() => undefined);
  }, [utils]);

  const { buildErrorMessage, isBuildRunning, startBuild } =
    useDashboardBuildControl({
      onSucceeded: refreshOfflineMonitoringRows,
    });

  // -------------------------------------------------------------------------
  // Universe: ABP-Part-2-verified + has trackingSystemRefId
  // -------------------------------------------------------------------------
  const offlineBaseSystems = useMemo<SystemRecord[]>(
    () =>
      part2EligibleSystemsForSizeReporting.filter(
        (system) => !!system.trackingSystemRefId,
      ),
    [part2EligibleSystemsForSizeReporting],
  );

  const offlineSystems = useMemo(
    () => offlineBaseSystems.filter((system) => !system.isReporting),
    [offlineBaseSystems],
  );

  // --- Dropdown option lists ---
  const offlineMonitoringOptions = useMemo(
    () =>
      Array.from(
        new Set(
          offlineBaseSystems.map(
            (system) => system.monitoringType || "Unknown",
          ),
        ),
      ).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
      ),
    [offlineBaseSystems],
  );

  const offlinePlatformOptions = useMemo(
    () =>
      Array.from(
        new Set(
          offlineBaseSystems.map(
            (system) => system.monitoringPlatform || "Unknown",
          ),
        ),
      ).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
      ),
    [offlineBaseSystems],
  );

  const offlineInstallerOptions = useMemo(
    () =>
      Array.from(
        new Set(
          offlineBaseSystems.map((system) => system.installerName || "Unknown"),
        ),
      ).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
      ),
    [offlineBaseSystems],
  );

  // -------------------------------------------------------------------------
  // Shared breakdown builder. Groups systems by a label extractor, computes
  // offline counts/contract-value per group, then sorts by the supplied keys.
  // -------------------------------------------------------------------------
  const buildBreakdownRows = useCallback(
    (
      getLabel: (system: SystemRecord) => string,
      sortBy: BreakdownSortKey,
      sortDir: "asc" | "desc",
    ): OfflineBreakdownRow[] => {
      const groups = new Map<
        string,
        {
          label: string;
          totalSystems: number;
          offlineSystems: number;
          totalContractValue: number;
          offlineContractValue: number;
        }
      >();

      offlineBaseSystems.forEach((system) => {
        const label = getLabel(system);
        let current = groups.get(label);
        if (!current) {
          current = {
            label,
            totalSystems: 0,
            offlineSystems: 0,
            totalContractValue: 0,
            offlineContractValue: 0,
          };
          groups.set(label, current);
        }
        current.totalSystems += 1;
        current.totalContractValue += resolveContractValueAmount(system);
        if (!system.isReporting) {
          current.offlineSystems += 1;
          current.offlineContractValue += resolveContractValueAmount(system);
        }
      });

      const rows = Array.from(groups.values()).map((group) => ({
        key: group.label,
        label: group.label,
        totalSystems: group.totalSystems,
        offlineSystems: group.offlineSystems,
        offlinePercent: toPercentValue(
          group.offlineSystems,
          group.totalSystems,
        ),
        offlineContractValue: group.offlineContractValue,
        totalContractValue: group.totalContractValue,
        offlineContractValuePercent: toPercentValue(
          group.offlineContractValue,
          group.totalContractValue,
        ),
      }));

      rows.sort((a, b) => {
        const direction = sortDir === "asc" ? 1 : -1;
        const byLabel =
          a.label.localeCompare(b.label, undefined, {
            sensitivity: "base",
            numeric: true,
          }) * direction;
        if (sortBy === "label") return byLabel;
        const aValue = a[sortBy] ?? -Infinity;
        const bValue = b[sortBy] ?? -Infinity;
        if (aValue === bValue) return byLabel;
        return ((aValue as number) - (bValue as number)) * direction;
      });
      return rows;
    },
    [offlineBaseSystems],
  );

  const offlineMonitoringBreakdownRows = useMemo(
    () =>
      buildBreakdownRows(
        (system) => system.monitoringType || "Unknown",
        offlineMonitoringSortBy,
        offlineMonitoringSortDir,
      ),
    [buildBreakdownRows, offlineMonitoringSortBy, offlineMonitoringSortDir],
  );

  const offlineInstallerBreakdownRows = useMemo(
    () =>
      buildBreakdownRows(
        (system) => system.installerName || "Unknown",
        offlineInstallerSortBy,
        offlineInstallerSortDir,
      ),
    [buildBreakdownRows, offlineInstallerSortBy, offlineInstallerSortDir],
  );

  const offlinePlatformBreakdownRows = useMemo(
    () =>
      buildBreakdownRows(
        (system) => system.monitoringPlatform || "Unknown",
        offlinePlatformSortBy,
        offlinePlatformSortDir,
      ),
    [buildBreakdownRows, offlinePlatformSortBy, offlinePlatformSortDir],
  );

  // -------------------------------------------------------------------------
  // Zero-reporting installer × platform (>10 systems)
  // -------------------------------------------------------------------------
  const zeroReportingInstallerPlatformRows = useMemo(() => {
    const groups = new Map<
      string,
      {
        installerName: string;
        monitoringPlatform: string;
        totalSystems: number;
        reportingSystems: number;
      }
    >();

    offlineBaseSystems.forEach((system) => {
      const installerName = system.installerName || "Unknown";
      const monitoringPlatform = system.monitoringPlatform || "Unknown";
      const key = `${installerName}__${monitoringPlatform}`;
      let current = groups.get(key);
      if (!current) {
        current = {
          installerName,
          monitoringPlatform,
          totalSystems: 0,
          reportingSystems: 0,
        };
        groups.set(key, current);
      }
      current.totalSystems += 1;
      if (system.isReporting) current.reportingSystems += 1;
    });

    return Array.from(groups.values())
      .filter(
        (group) => group.totalSystems > 10 && group.reportingSystems === 0,
      )
      .map((group) => ({
        ...group,
        reportingPercent: toPercentValue(
          group.reportingSystems,
          group.totalSystems,
        ),
      }))
      .sort((a, b) => b.totalSystems - a.totalSystems);
  }, [offlineBaseSystems]);

  // -------------------------------------------------------------------------
  // Detail table: filtered + sorted + paginated
  // -------------------------------------------------------------------------
  const filteredOfflineSystems = useMemo(() => {
    const normalizedSearch = deferredOfflineSearch.trim().toLowerCase();
    const rows = offlineSystems.filter((system) => {
      const monitoringMatch =
        offlineMonitoringFilter === "All"
          ? true
          : system.monitoringType === offlineMonitoringFilter;
      if (!monitoringMatch) return false;
      const platformMatch =
        offlinePlatformFilter === "All"
          ? true
          : system.monitoringPlatform === offlinePlatformFilter;
      if (!platformMatch) return false;
      const installerMatch =
        offlineInstallerFilter === "All"
          ? true
          : system.installerName === offlineInstallerFilter;
      if (!installerMatch) return false;
      if (!normalizedSearch) return true;
      const haystack = [
        system.systemName,
        system.systemId ?? "",
        system.trackingSystemRefId ?? "",
        system.monitoringType,
        system.monitoringPlatform,
        system.installerName,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedSearch);
    });

    rows.sort((a, b) => {
      const direction = offlineDetailSortDir === "asc" ? 1 : -1;
      if (offlineDetailSortBy === "systemName") {
        return (
          a.systemName.localeCompare(b.systemName, undefined, {
            sensitivity: "base",
            numeric: true,
          }) * direction
        );
      }
      if (offlineDetailSortBy === "monitoringType") {
        return (
          a.monitoringType.localeCompare(b.monitoringType, undefined, {
            sensitivity: "base",
            numeric: true,
          }) * direction
        );
      }
      if (offlineDetailSortBy === "monitoringPlatform") {
        return (
          a.monitoringPlatform.localeCompare(b.monitoringPlatform, undefined, {
            sensitivity: "base",
            numeric: true,
          }) * direction
        );
      }
      if (offlineDetailSortBy === "installerName") {
        return (
          a.installerName.localeCompare(b.installerName, undefined, {
            sensitivity: "base",
            numeric: true,
          }) * direction
        );
      }
      if (offlineDetailSortBy === "latestReportingDate") {
        const aTime = a.latestReportingDate?.getTime() ?? -Infinity;
        const bTime = b.latestReportingDate?.getTime() ?? -Infinity;
        if (aTime === bTime) {
          return (
            a.systemName.localeCompare(b.systemName, undefined, {
              sensitivity: "base",
              numeric: true,
            }) * direction
          );
        }
        return (aTime - bTime) * direction;
      }
      const aValue = resolveContractValueAmount(a);
      const bValue = resolveContractValueAmount(b);
      if (aValue === bValue) {
        return (
          a.systemName.localeCompare(b.systemName, undefined, {
            sensitivity: "base",
            numeric: true,
          }) * direction
        );
      }
      return (aValue - bValue) * direction;
    });
    return rows;
  }, [
    offlineDetailSortBy,
    offlineDetailSortDir,
    offlineInstallerFilter,
    offlineMonitoringFilter,
    offlinePlatformFilter,
    deferredOfflineSearch,
    offlineSystems,
  ]);

  const offlineDetailTotalPages = Math.max(
    1,
    Math.ceil(filteredOfflineSystems.length / OFFLINE_DETAIL_PAGE_SIZE),
  );
  const offlineDetailCurrentPage = Math.min(
    offlineDetailPage,
    offlineDetailTotalPages,
  );
  const offlineDetailPageStartIndex =
    (offlineDetailCurrentPage - 1) * OFFLINE_DETAIL_PAGE_SIZE;
  const offlineDetailPageEndIndex =
    offlineDetailPageStartIndex + OFFLINE_DETAIL_PAGE_SIZE;
  const visibleOfflineDetailRows = useMemo(
    () =>
      filteredOfflineSystems.slice(
        offlineDetailPageStartIndex,
        offlineDetailPageEndIndex,
      ),
    [
      filteredOfflineSystems,
      offlineDetailPageEndIndex,
      offlineDetailPageStartIndex,
    ],
  );

  // Filter change → reset to first page
  useEffect(() => {
    setOfflineDetailPage(1);
  }, [
    offlineDetailSortBy,
    offlineDetailSortDir,
    offlineInstallerFilter,
    offlineMonitoringFilter,
    offlinePlatformFilter,
    offlineSearch,
  ]);

  // Page index bounds clamp
  useEffect(() => {
    if (offlineDetailPage <= offlineDetailTotalPages) return;
    setOfflineDetailPage(offlineDetailTotalPages);
  }, [offlineDetailPage, offlineDetailTotalPages]);

  // -------------------------------------------------------------------------
  // Summary tiles (header strip)
  // -------------------------------------------------------------------------
  const offlineSummary = useMemo(() => {
    const totalOfflineContractValue = offlineSystems.reduce(
      (sum, system) => sum + resolveContractValueAmount(system),
      0,
    );
    const totalPortfolioContractValue = offlineBaseSystems.reduce(
      (sum, system) => sum + resolveContractValueAmount(system),
      0,
    );
    return {
      offlineSystemCount: offlineSystems.length,
      offlineSystemPercent: toPercentValue(
        offlineSystems.length,
        offlineBaseSystems.length,
      ),
      filteredOfflineCount: filteredOfflineSystems.length,
      monitoringTypeCount: offlineMonitoringBreakdownRows.length,
      monitoringPlatformCount: offlinePlatformBreakdownRows.length,
      installerCount: offlineInstallerBreakdownRows.length,
      totalOfflineContractValue,
      totalPortfolioContractValue,
      offlineContractValuePercent: toPercentValue(
        totalOfflineContractValue,
        totalPortfolioContractValue,
      ),
    };
  }, [
    filteredOfflineSystems.length,
    offlineInstallerBreakdownRows.length,
    offlineMonitoringBreakdownRows.length,
    offlinePlatformBreakdownRows.length,
    offlineBaseSystems,
    offlineSystems,
  ]);

  // -------------------------------------------------------------------------
  // CSV downloads
  // -------------------------------------------------------------------------
  const downloadOfflineSystemsCsv = useCallback(() => {
    const headers = [
      "nonid",
      "csg_portal_id",
      "abp_report_id",
      "system_name",
      "installer_name",
      "monitoring_method",
      "monitoring_platform",
      "online_monitoring_access_type",
      "online_monitoring",
      "online_monitoring_granted_username",
      "online_monitoring_username",
      "online_monitoring_system_name",
      "online_monitoring_system_id",
      "online_monitoring_password",
      "online_monitoring_website_api_link",
      "online_monitoring_entry_method",
      "online_monitoring_notes",
      "online_monitoring_self_report",
      "online_monitoring_rgm_info",
      "online_monitoring_no_submit_generation",
      "system_online",
      "last_reported_online_date",
      "last_gats_reporting_date",
      "last_report_kwh",
      "contract_value",
    ];

    const rows = offlineSystems
      .slice()
      .sort((a, b) =>
        a.systemName.localeCompare(b.systemName, undefined, {
          sensitivity: "base",
          numeric: true,
        }),
      )
      .map((system) => {
        const keyById = system.systemId ? `id:${system.systemId}` : "";
        const keyByTracking = system.trackingSystemRefId
          ? `tracking:${system.trackingSystemRefId}`
          : "";
        const keyByName = `name:${system.systemName.toLowerCase()}`;

        const abpReportId =
          (keyById ? abpApplicationIdBySystemKey.get(keyById) : undefined) ??
          (keyByTracking
            ? abpApplicationIdBySystemKey.get(keyByTracking)
            : undefined) ??
          abpApplicationIdBySystemKey.get(keyByName) ??
          "";
        const monitoringDetails = getMonitoringDetailsForSystem(
          system,
          monitoringDetailsBySystemKey,
        );

        return {
          nonid: system.trackingSystemRefId ?? "",
          csg_portal_id: system.systemId ?? "",
          abp_report_id: abpReportId,
          system_name: system.systemName,
          installer_name: system.installerName,
          monitoring_method: system.monitoringType,
          monitoring_platform: system.monitoringPlatform,
          online_monitoring_access_type:
            monitoringDetails?.online_monitoring_access_type ?? "",
          online_monitoring: monitoringDetails?.online_monitoring ?? "",
          online_monitoring_granted_username:
            monitoringDetails?.online_monitoring_granted_username ?? "",
          online_monitoring_username:
            monitoringDetails?.online_monitoring_username ?? "",
          online_monitoring_system_name:
            monitoringDetails?.online_monitoring_system_name ?? "",
          online_monitoring_system_id:
            monitoringDetails?.online_monitoring_system_id ?? "",
          online_monitoring_password:
            monitoringDetails?.online_monitoring_password ?? "",
          online_monitoring_website_api_link:
            monitoringDetails?.online_monitoring_website_api_link ?? "",
          online_monitoring_entry_method:
            monitoringDetails?.online_monitoring_entry_method ?? "",
          online_monitoring_notes:
            monitoringDetails?.online_monitoring_notes ?? "",
          online_monitoring_self_report:
            monitoringDetails?.online_monitoring_self_report ?? "",
          online_monitoring_rgm_info:
            monitoringDetails?.online_monitoring_rgm_info ?? "",
          online_monitoring_no_submit_generation:
            monitoringDetails?.online_monitoring_no_submit_generation ?? "",
          system_online: monitoringDetails?.system_online ?? "",
          last_reported_online_date:
            monitoringDetails?.last_reported_online_date ?? "",
          last_gats_reporting_date: formatDate(system.latestReportingDate),
          last_report_kwh: system.latestReportingKwh ?? "",
          contract_value: resolveContractValueAmount(system),
        };
      });

    const csv = buildCsv(headers, rows);
    const fileName = `offline-systems-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [
    abpApplicationIdBySystemKey,
    monitoringDetailsBySystemKey,
    offlineSystems,
  ]);

  const downloadOfflineDetailFilteredCsv = useCallback(() => {
    if (filteredOfflineSystems.length === 0) return;

    const headers = [
      "system_name",
      "system_id",
      "tracking_id",
      "monitoring_method",
      "monitoring_platform",
      "access_type",
      "monitoring_site_id",
      "monitoring_site_name",
      "monitoring_link",
      "monitoring_username",
      "monitoring_password",
      "installer_name",
      "last_reporting_date",
      "last_report_kwh",
      "contract_value",
    ];

    const rows = filteredOfflineSystems.map((system) => {
      const accessFields = resolveOfflineMonitoringAccessFields(
        system,
        monitoringDetailsBySystemKey,
      );
      return {
        system_name: system.systemName,
        system_id: system.systemId ?? "",
        tracking_id: system.trackingSystemRefId ?? "",
        monitoring_method: system.monitoringType,
        monitoring_platform: system.monitoringPlatform,
        access_type: accessFields.accessType,
        monitoring_site_id: accessFields.monitoringSiteId,
        monitoring_site_name: accessFields.monitoringSiteName,
        monitoring_link: accessFields.monitoringLink,
        monitoring_username: accessFields.monitoringUsername,
        monitoring_password: accessFields.monitoringPassword,
        installer_name: system.installerName,
        last_reporting_date: formatDate(system.latestReportingDate),
        last_report_kwh: system.latestReportingKwh ?? "",
        contract_value: resolveContractValueAmount(system),
      };
    });

    const csv = buildCsv(headers, rows);
    const fileName = `offline-systems-detail-filtered-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.csv`;
    triggerCsvDownload(fileName, csv);
  }, [filteredOfflineSystems, monitoringDetailsBySystemKey]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-4 mt-4">
      <Card id="offline-overview" className="scroll-mt-24">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle className="text-base">
                Non-Reporting Systems by Monitoring Method, Platform, and
                Installer
              </CardTitle>
              <CardDescription>
                Offline status means not reporting to GATS within the last 3
                months.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadOfflineSystemsCsv}
            >
              Download Offline Systems CSV
            </Button>
          </div>
        </CardHeader>
      </Card>

      <Card className="border-slate-200/80 bg-slate-50/70">
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Jump to
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => jumpToSection("offline-overview")}
            >
              Overview
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => jumpToSection("offline-summary")}
            >
              Summary
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => jumpToSection("offline-by-method")}
            >
              By Method
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => jumpToSection("offline-by-platform")}
            >
              By Platform
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => jumpToSection("offline-by-installer")}
            >
              By Installer
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => jumpToSection("offline-zero-reporting")}
            >
              0% Reporting
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => jumpToSection("offline-detail")}
            >
              Offline Detail
            </Button>
          </div>
        </CardContent>
      </Card>

      <div
        id="offline-summary"
        className="grid gap-4 md:grid-cols-2 xl:grid-cols-6 scroll-mt-24"
      >
        <Card>
          <CardHeader>
            <CardDescription>Total Offline Systems</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(offlineSummary.offlineSystemCount)}
            </CardTitle>
            <CardDescription>
              {formatPercent(offlineSummary.offlineSystemPercent)}
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Filtered Offline Systems</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(offlineSummary.filteredOfflineCount)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Monitoring Methods</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(offlineSummary.monitoringTypeCount)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Monitoring Platforms</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(offlineSummary.monitoringPlatformCount)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Installers</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(offlineSummary.installerCount)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Offline Contract Value</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(offlineSummary.totalOfflineContractValue)}
            </CardTitle>
            <CardDescription>
              {formatPercent(offlineSummary.offlineContractValuePercent)}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card id="offline-by-method" className="scroll-mt-24">
          <CardHeader>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <CardTitle className="text-base">
                  Offline by Monitoring Method
                </CardTitle>
                <CardDescription>
                  Includes offline percentage and contract value by monitoring
                  method (Granted Access, Password, Link, etc).
                </CardDescription>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">
                    Sort by
                  </label>
                  <select
                    className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                    value={offlineMonitoringSortBy}
                    onChange={(event) =>
                      setOfflineMonitoringSortBy(
                        event.target.value as BreakdownSortKey,
                      )
                    }
                  >
                    <option value="offlineSystems">Offline Systems</option>
                    <option value="offlinePercent">Offline %</option>
                    <option value="offlineContractValue">
                      Offline Contract Value
                    </option>
                    <option value="label">Monitoring Method</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">
                    Direction
                  </label>
                  <select
                    className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                    value={offlineMonitoringSortDir}
                    onChange={(event) =>
                      setOfflineMonitoringSortDir(
                        event.target.value as "asc" | "desc",
                      )
                    }
                  >
                    <option value="desc">Descending</option>
                    <option value="asc">Ascending</option>
                  </select>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Monitoring Method</TableHead>
                  <TableHead>Total Systems</TableHead>
                  <TableHead>Offline Systems</TableHead>
                  <TableHead>Offline %</TableHead>
                  <TableHead>Offline Contract Value</TableHead>
                  <TableHead>Offline Value %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {offlineMonitoringBreakdownRows.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell className="font-medium">{row.label}</TableCell>
                    <TableCell>{formatNumber(row.totalSystems)}</TableCell>
                    <TableCell>{formatNumber(row.offlineSystems)}</TableCell>
                    <TableCell>{formatPercent(row.offlinePercent)}</TableCell>
                    <TableCell>
                      {formatCurrency(row.offlineContractValue)}
                    </TableCell>
                    <TableCell>
                      {formatPercent(row.offlineContractValuePercent)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card id="offline-by-platform" className="scroll-mt-24">
          <CardHeader>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <CardTitle className="text-base">
                  Offline by Monitoring Platform
                </CardTitle>
                <CardDescription>
                  Includes offline percentage and contract value by monitoring
                  platform (SolarEdge, Enphase, ennexOS, etc).
                </CardDescription>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">
                    Sort by
                  </label>
                  <select
                    className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                    value={offlinePlatformSortBy}
                    onChange={(event) =>
                      setOfflinePlatformSortBy(
                        event.target.value as BreakdownSortKey,
                      )
                    }
                  >
                    <option value="offlineSystems">Offline Systems</option>
                    <option value="offlinePercent">Offline %</option>
                    <option value="offlineContractValue">
                      Offline Contract Value
                    </option>
                    <option value="label">Monitoring Platform</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">
                    Direction
                  </label>
                  <select
                    className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                    value={offlinePlatformSortDir}
                    onChange={(event) =>
                      setOfflinePlatformSortDir(
                        event.target.value as "asc" | "desc",
                      )
                    }
                  >
                    <option value="desc">Descending</option>
                    <option value="asc">Ascending</option>
                  </select>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Monitoring Platform</TableHead>
                  <TableHead>Total Systems</TableHead>
                  <TableHead>Offline Systems</TableHead>
                  <TableHead>Offline %</TableHead>
                  <TableHead>Offline Contract Value</TableHead>
                  <TableHead>Offline Value %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {offlinePlatformBreakdownRows.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell className="font-medium">{row.label}</TableCell>
                    <TableCell>{formatNumber(row.totalSystems)}</TableCell>
                    <TableCell>{formatNumber(row.offlineSystems)}</TableCell>
                    <TableCell>{formatPercent(row.offlinePercent)}</TableCell>
                    <TableCell>
                      {formatCurrency(row.offlineContractValue)}
                    </TableCell>
                    <TableCell>
                      {formatPercent(row.offlineContractValuePercent)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card id="offline-by-installer" className="scroll-mt-24">
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <CardTitle className="text-base">Offline by Installer</CardTitle>
              <CardDescription>
                Includes offline percentage and contract value by installer.
              </CardDescription>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-700">
                  Sort by
                </label>
                <select
                  className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                  value={offlineInstallerSortBy}
                  onChange={(event) =>
                    setOfflineInstallerSortBy(
                      event.target.value as BreakdownSortKey,
                    )
                  }
                >
                  <option value="offlineSystems">Offline Systems</option>
                  <option value="offlinePercent">Offline %</option>
                  <option value="offlineContractValue">
                    Offline Contract Value
                  </option>
                  <option value="label">Installer</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-700">
                  Direction
                </label>
                <select
                  className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                  value={offlineInstallerSortDir}
                  onChange={(event) =>
                    setOfflineInstallerSortDir(
                      event.target.value as "asc" | "desc",
                    )
                  }
                >
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Installer</TableHead>
                <TableHead>Total Systems</TableHead>
                <TableHead>Offline Systems</TableHead>
                <TableHead>Offline %</TableHead>
                <TableHead>Offline Contract Value</TableHead>
                <TableHead>Offline Value %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {offlineInstallerBreakdownRows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="font-medium">{row.label}</TableCell>
                  <TableCell>{formatNumber(row.totalSystems)}</TableCell>
                  <TableCell>{formatNumber(row.offlineSystems)}</TableCell>
                  <TableCell>{formatPercent(row.offlinePercent)}</TableCell>
                  <TableCell>
                    {formatCurrency(row.offlineContractValue)}
                  </TableCell>
                  <TableCell>
                    {formatPercent(row.offlineContractValuePercent)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card id="offline-zero-reporting" className="scroll-mt-24">
        <CardHeader>
          <CardTitle className="text-base">
            Installer + Monitoring Platform with 0% Reporting (&gt;10 Systems)
          </CardTitle>
          <CardDescription>
            Combinations where no systems are reporting and total systems exceed
            10.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {zeroReportingInstallerPlatformRows.length === 0 ? (
            <p className="text-sm text-slate-600">
              No combinations currently match this criteria.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Installer</TableHead>
                  <TableHead>Monitoring Platform</TableHead>
                  <TableHead>Total Systems</TableHead>
                  <TableHead>Reporting %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {zeroReportingInstallerPlatformRows.map((row) => (
                  <TableRow
                    key={`${row.installerName}-${row.monitoringPlatform}`}
                  >
                    <TableCell className="font-medium">
                      {row.installerName}
                    </TableCell>
                    <TableCell>{row.monitoringPlatform}</TableCell>
                    <TableCell>{formatNumber(row.totalSystems)}</TableCell>
                    <TableCell className="text-rose-700 font-semibold">
                      {formatPercent(row.reportingPercent)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card id="offline-detail" className="scroll-mt-24">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle className="text-base">
                Offline Systems Detail
              </CardTitle>
              <CardDescription>
                Filterable and sortable list of non-reporting systems.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadOfflineDetailFilteredCsv}
              disabled={filteredOfflineSystems.length === 0}
            >
              Export Filtered Table CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            <div className="text-slate-700">
              Loaded {formatNumber(monitoringDetailsBySystemKey.size)}{" "}
              monitoring detail rows
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refreshOfflineMonitoringRows()}
              >
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={startBuild}
                disabled={isBuildRunning}
              >
                {isBuildRunning ? "Building..." : "Rebuild table"}
              </Button>
            </div>
          </div>

          {buildErrorMessage ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
              {buildErrorMessage}
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Monitoring method
              </label>
              <select
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={offlineMonitoringFilter}
                onChange={(event) =>
                  setOfflineMonitoringFilter(event.target.value)
                }
              >
                <option value="All">All Monitoring Methods</option>
                {offlineMonitoringOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Monitoring platform
              </label>
              <select
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={offlinePlatformFilter}
                onChange={(event) =>
                  setOfflinePlatformFilter(event.target.value)
                }
              >
                <option value="All">All Platforms</option>
                {offlinePlatformOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Installer
              </label>
              <select
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={offlineInstallerFilter}
                onChange={(event) =>
                  setOfflineInstallerFilter(event.target.value)
                }
              >
                <option value="All">All Installers</option>
                {offlineInstallerOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Sort by
              </label>
              <select
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={offlineDetailSortBy}
                onChange={(event) =>
                  setOfflineDetailSortBy(
                    event.target.value as OfflineDetailSortKey,
                  )
                }
              >
                <option value="contractedValue">Contract Value</option>
                <option value="latestReportingDate">Last Reporting Date</option>
                <option value="systemName">System Name</option>
                <option value="monitoringType">Monitoring Method</option>
                <option value="monitoringPlatform">Monitoring Platform</option>
                <option value="installerName">Installer</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Direction
              </label>
              <select
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={offlineDetailSortDir}
                onChange={(event) =>
                  setOfflineDetailSortDir(event.target.value as "asc" | "desc")
                }
              >
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Search
              </label>
              <Input
                placeholder="System, IDs, method, platform, installer, monitoring access..."
                value={offlineSearch}
                onChange={(event) => setOfflineSearch(event.target.value)}
              />
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>System</TableHead>
                <TableHead>system_id</TableHead>
                <TableHead>Tracking ID</TableHead>
                <TableHead>Monitoring Method</TableHead>
                <TableHead>Monitoring Platform</TableHead>
                <TableHead>Access Type</TableHead>
                <TableHead>Monitoring Site ID</TableHead>
                <TableHead>Monitoring Site Name</TableHead>
                <TableHead>Monitoring Link</TableHead>
                <TableHead>Monitoring Username</TableHead>
                <TableHead>Monitoring Password</TableHead>
                <TableHead>Installer</TableHead>
                <TableHead>Last Reporting Date</TableHead>
                <TableHead>Last Report (kWh)</TableHead>
                <TableHead>Contract Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleOfflineDetailRows.map((system) => {
                const accessFields = resolveOfflineMonitoringAccessFields(
                  system,
                  monitoringDetailsBySystemKey,
                );
                return (
                  <TableRow key={system.key}>
                    <TableCell className="font-medium">
                      {system.systemName}
                    </TableCell>
                    <TableCell>{system.systemId ?? "N/A"}</TableCell>
                    <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                    <TableCell>{system.monitoringType}</TableCell>
                    <TableCell>{system.monitoringPlatform}</TableCell>
                    <TableCell>{accessFields.accessType || "N/A"}</TableCell>
                    <TableCell>
                      {accessFields.monitoringSiteId || "N/A"}
                    </TableCell>
                    <TableCell>
                      {accessFields.monitoringSiteName || "N/A"}
                    </TableCell>
                    <TableCell className="max-w-[18rem] break-all">
                      {accessFields.monitoringLink ? (
                        <a
                          href={accessFields.monitoringLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 underline"
                        >
                          {accessFields.monitoringLink}
                        </a>
                      ) : (
                        "N/A"
                      )}
                    </TableCell>
                    <TableCell>
                      {accessFields.monitoringUsername || "N/A"}
                    </TableCell>
                    <TableCell>
                      {accessFields.monitoringPassword || "N/A"}
                    </TableCell>
                    <TableCell>{system.installerName}</TableCell>
                    <TableCell>
                      {formatDate(system.latestReportingDate)}
                    </TableCell>
                    <TableCell>
                      {formatKwh(system.latestReportingKwh)}
                    </TableCell>
                    <TableCell>
                      {formatCurrency(system.contractedValue)}
                    </TableCell>
                  </TableRow>
                );
              })}
              {visibleOfflineDetailRows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={15}
                    className="py-6 text-center text-slate-500"
                  >
                    No offline systems match the current filters.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>
              Showing {formatNumber(visibleOfflineDetailRows.length)} of{" "}
              {formatNumber(filteredOfflineSystems.length)} rows
            </span>
            <span>
              Page {formatNumber(offlineDetailCurrentPage)} of{" "}
              {formatNumber(offlineDetailTotalPages)}
            </span>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setOfflineDetailPage((page) => Math.max(1, page - 1))
              }
              disabled={offlineDetailCurrentPage <= 1}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setOfflineDetailPage((page) =>
                  Math.min(offlineDetailTotalPages, page + 1),
                )
              }
              disabled={offlineDetailCurrentPage >= offlineDetailTotalPages}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      <AskAiPanel
        moduleKey="solar-rec-offline-monitoring"
        title="Ask AI about offline monitoring"
        contextGetter={() => ({
          summary: offlineSummary,
          monitoringTypeBreakdown: offlineMonitoringBreakdownRows,
          platformBreakdown: offlinePlatformBreakdownRows,
          installerBreakdown: offlineInstallerBreakdownRows,
          zeroReportingInstallerPlatform: zeroReportingInstallerPlatformRows,
          sampleOfflineSystems: filteredOfflineSystems
            .slice(0, 20)
            .map((s) => ({
              systemName: s.systemName,
              trackingSystemRefId: s.trackingSystemRefId,
              installedKwAc: s.installedKwAc,
              contractedValue: s.contractedValue,
              monitoringType: s.monitoringType,
              monitoringPlatform: s.monitoringPlatform,
              latestReportingDate: s.latestReportingDate
                ? s.latestReportingDate.toISOString().slice(0, 10)
                : null,
              contractedDate: s.contractedDate
                ? s.contractedDate.toISOString().slice(0, 10)
                : null,
            })),
        })}
      />
    </div>
  );
});
