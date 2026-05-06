/**
 * Performance Ratio tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14) to stop the god
 * component's 125-useMemo cascade from freezing the browser on tab
 * switch. This component owns everything specific to the tab:
 *   - filter / sort / pagination state (13 useStates)
 *   - the match-index builder, converted-read parser, and result joiner
 *     (16 useMemos, including the triple-nested index builder)
 *   - compliant-source CRUD, localStorage sync, and CSV import/export
 *
 * The heavy performance-ratio computation now runs server-side; this tab
 * receives only small dataset-existence sentinels and derives compliant-source
 * auto labels from the server aggregate rows. This keeps the tab isolated to
 * its own mount lifecycle: switching tabs unmounts it, and its local memos are
 * garbage collected until you come back.
 *
 * Do NOT re-introduce `isPerformanceRatioTabActive` gates inside this
 * component — the gate IS the mount.
 */

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { clean, formatCurrency, formatPercent } from "@/lib/helpers";
import { AskAiPanel } from "@/components/AskAiPanel";
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
  matchesExpectedHeaders,
  parseCsv,
} from "@/solar-rec-dashboard/lib/csvIo";
// Phase 5d PR 1 (2026-04-29) — server-side aggregator for the
// performance-ratio compute. Salvage PR B (2026-04-29) — the
// client fallback memo + its 3 upstream sub-memos
// (`generatorDateOnlineByTrackingId`, `portalMonitoringCandidates`,
// `performanceRatioMatchIndexes`) and the
// `deferredConvertedReads` `useDeferredValue` are gone. The tab
// reads exclusively from `getDashboardPerformanceRatio`. Imports
// the fallback consumed (`getDatasetColumnarSource`,
// `buildGeneratorDateOnlineByTrackingId`,
// `calculateExpectedWhForRange`,
// `getMonitoringDetailsForSystem`, the 4 normalizers,
// `splitRawCandidates`, `uniqueNonEmpty`,
// `MonitoringDetailsRecord`, `PortalMonitoringCandidate`,
// `AnnualProductionProfile`, `GenerationBaseline`,
// `parseEnergyToWh`, `parseDate`) are dropped along with it.
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
import {
  createLogId,
  formatDate,
  formatMonthYear,
  formatNumber,
  formatSignedNumber,
  getAutoCompliantSourcePriority,
  getCsvValueByHeader,
  isTenKwAcOrLess,
  isValidCompliantSourceText,
  resolveContractValueAmount,
  resolveMonitoringPlatformCompliantSource,
  toPercentValue,
  toReadWindowMonthStart,
} from "@/solar-rec-dashboard/lib/helpers";
import {
  COMPLIANT_REPORT_PAGE_SIZE,
  COMPLIANT_SOURCE_PAGE_SIZE,
  COMPLIANT_SOURCE_STORAGE_KEY,
  MAX_COMPLIANT_FILE_BYTES,
  MAX_COMPLIANT_SOURCE_CHARS,
  PERFORMANCE_RATIO_PAGE_SIZE,
  TEN_KW_COMPLIANT_SOURCE,
} from "@/solar-rec-dashboard/lib/constants";
import type {
  CompliantPerformanceRatioRow,
  CompliantSourceEntry,
  CompliantSourceEvidence,
  CompliantSourceTableRow,
  PerformanceRatioMatchType,
  PerformanceRatioRow,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PerformanceRatioTabProps {
  // Salvage PR B (2026-04-29) — props for the client fallback compute
  // (`generatorDetails`, `monitoringDetailsBySystemKey`,
  // `annualProductionByTrackingId`,
  // `generationBaselineByTrackingId`) are gone. The tab now reads
  // exclusively from `getDashboardPerformanceRatio`.

  // Server-driven existence sentinels for the two datasets the
  // empty-state check below cares about ("Upload these CSVs to
  // populate"). The compute itself runs server-side via
  // `getDashboardPerformanceRatio`. Phase 5e Followup #4 step 1
  // (2026-04-29) — replaced the prior `convertedReads: CsvDataset
  // | null` + `annualProductionEstimates: CsvDataset | null`
  // props, which forced the parent to hydrate
  // `datasets.convertedReads.rows` (50–150 MB on a populated
  // scope) just to know whether the file existed. Driven by
  // `getDatasetSummariesAll`'s rowCount.
  hasConvertedReads: boolean;
  hasAnnualProductionEstimates: boolean;
  convertedReadsLabel: string;
  annualProductionEstimatesLabel: string;

}

// ---------------------------------------------------------------------------
// localStorage bridge for compliant source entries. Evidence objectUrls
// are ephemeral (File blobs) so they never make it to disk; only the
// text metadata round-trips.
// ---------------------------------------------------------------------------

function loadPersistedCompliantSources(): CompliantSourceEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(COMPLIANT_SOURCE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{
      portalId: string;
      compliantSource: string;
      updatedAt: string;
    }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const portalId = clean(item.portalId);
        const compliantSource = clean(item.compliantSource);
        const updatedAt = new Date(item.updatedAt);
        if (
          !portalId ||
          !compliantSource ||
          Number.isNaN(updatedAt.getTime())
        )
          return null;
        return {
          portalId,
          compliantSource,
          updatedAt,
          evidence: [],
        } satisfies CompliantSourceEntry;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  } catch {
    return [];
  }
}

function reviveNullableDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export function revivePerformanceRatioRows(
  rows: unknown
): PerformanceRatioRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is Record<string, unknown> => {
      return Boolean(row) && typeof row === "object";
    })
    .map((row) => ({
      ...(row as unknown as PerformanceRatioRow),
      readDate: reviveNullableDate(row.readDate),
      part2VerificationDate: reviveNullableDate(row.part2VerificationDate),
      baselineDate: reviveNullableDate(row.baselineDate),
    }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function PerformanceRatioTab(props: PerformanceRatioTabProps) {
  const {
    hasConvertedReads,
    hasAnnualProductionEstimates,
    convertedReadsLabel,
    annualProductionEstimatesLabel,
  } = props;

  // --- Filter / sort / pagination state ---
  const [performanceRatioMonitoringFilter, setPerformanceRatioMonitoringFilter] =
    useState("All");
  const [performanceRatioMatchFilter, setPerformanceRatioMatchFilter] =
    useState<PerformanceRatioMatchType | "All">("All");
  const [performanceRatioSearch, setPerformanceRatioSearch] = useState("");
  // Phase 18: useDeferredValue marks the search string as a
  // low-priority update so the `filteredPerformanceRatioRows` memo
  // (which filter-sorts over ~100k+ rows on every keystroke) runs
  // after the input re-renders. The user still sees the character
  // they just typed instantly; the filtered table catches up a
  // frame or two later without blocking keystrokes.
  const deferredPerformanceRatioSearch = useDeferredValue(performanceRatioSearch);
  const [performanceRatioSortBy, setPerformanceRatioSortBy] = useState<
    | "performanceRatioPercent"
    | "productionDeltaWh"
    | "expectedProductionWh"
    | "systemName"
    | "readDate"
  >("performanceRatioPercent");
  const [performanceRatioSortDir, setPerformanceRatioSortDir] = useState<
    "asc" | "desc"
  >("desc");
  const [performanceRatioPage, setPerformanceRatioPage] = useState(1);
  const [compliantSourcePage, setCompliantSourcePage] = useState(1);
  const [compliantReportPage, setCompliantReportPage] = useState(1);

  // --- Compliant source entry state (localStorage-persisted) ---
  const [compliantSourceEntries, setCompliantSourceEntries] = useState<
    CompliantSourceEntry[]
  >(() => loadPersistedCompliantSources());
  const [compliantSourcePortalIdInput, setCompliantSourcePortalIdInput] =
    useState("");
  const [compliantSourceTextInput, setCompliantSourceTextInput] = useState("");
  const [compliantSourceEvidenceFiles, setCompliantSourceEvidenceFiles] =
    useState<File[]>([]);
  const [compliantSourceUploadError, setCompliantSourceUploadError] = useState<
    string | null
  >(null);
  const [compliantSourceCsvMessage, setCompliantSourceCsvMessage] = useState<
    string | null
  >(null);

  const compliantSourceEntriesRef = useRef<CompliantSourceEntry[]>(
    compliantSourceEntries,
  );
  compliantSourceEntriesRef.current = compliantSourceEntries;

  // Persist metadata to localStorage on every change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = compliantSourceEntries.map((entry) => ({
      portalId: entry.portalId,
      compliantSource: entry.compliantSource,
      updatedAt: entry.updatedAt.toISOString(),
    }));
    window.localStorage.setItem(
      COMPLIANT_SOURCE_STORAGE_KEY,
      JSON.stringify(payload),
    );
  }, [compliantSourceEntries]);

  // Revoke object URLs when the tab unmounts.
  useEffect(() => {
    return () => {
      compliantSourceEntriesRef.current.forEach((entry) => {
        entry.evidence.forEach((item) => URL.revokeObjectURL(item.objectUrl));
      });
    };
  }, []);


  // -------------------------------------------------------------------------
  // Phase 5d PR 1 (2026-04-29) — canonical performance-ratio source.
  //
  // Pulls from `getDashboardPerformanceRatio` (server-side aggregator
  // with `withArtifactCache` memoization). On a cache hit the wire
  // payload is ~10–200 KB depending on scope size; on cache miss the
  // server runs the same compute the client used to do, then caches
  // by the 7 input batch IDs.
  //
  // Salvage PR B (2026-04-29) — the client fallback memo
  // (`_clientFallbackPerformanceRatioResult`) is gone. During the
  // initial cache miss the tab renders empty for the few hundred ms
  // the query takes to land — matches every other server-aggregator-
  // backed tab on the dashboard. The 7 dataset props the fallback
  // depended on (`convertedReads`, `annualProductionEstimates`,
  // `generatorDetails`, `monitoringDetailsBySystemKey`,
  // `annualProductionByTrackingId`,
  // `generationBaselineByTrackingId`) are dropped along with it.
  // The dataset-existence empty-state check below (`!convertedReads
  // || !annualProductionEstimates`) keeps using `convertedReads` /
  // `annualProductionEstimates` /  `convertedReadsLabel` /
  // `annualProductionEstimatesLabel` to surface a clear "upload
  // these CSVs first" message — those 4 props stay.
  // -------------------------------------------------------------------------
  const performanceRatioQuery =
    solarRecTrpc.solarRecDashboard.getDashboardPerformanceRatio.useQuery();
  const performanceRatioResult = useMemo(() => {
    const data = performanceRatioQuery.data;
    if (!data) {
      return {
        rows: [] as PerformanceRatioRow[],
        convertedReadCount: 0,
        matchedConvertedReads: 0,
        unmatchedConvertedReads: 0,
        invalidConvertedReads: 0,
      };
    }
    return {
      rows: revivePerformanceRatioRows(data.rows),
      convertedReadCount: data.convertedReadCount,
      matchedConvertedReads: data.matchedConvertedReads,
      unmatchedConvertedReads: data.unmatchedConvertedReads,
      invalidConvertedReads: data.invalidConvertedReads,
    };
  }, [performanceRatioQuery.data]);

  // -------------------------------------------------------------------------
  // Filters / sort / summary / pagination
  // -------------------------------------------------------------------------
  const performanceRatioMonitoringOptions = useMemo(
    () =>
      Array.from(
        new Set(performanceRatioResult.rows.map((row) => row.monitoring)),
      )
        .filter(Boolean)
        .sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
        ),
    [performanceRatioResult.rows],
  );

  const filteredPerformanceRatioRows = useMemo(() => {
    const search = deferredPerformanceRatioSearch.trim().toLowerCase();

    const rows = performanceRatioResult.rows.filter((row) => {
      if (
        performanceRatioMonitoringFilter !== "All" &&
        row.monitoring !== performanceRatioMonitoringFilter
      )
        return false;
      if (
        performanceRatioMatchFilter !== "All" &&
        row.matchType !== performanceRatioMatchFilter
      )
        return false;
      if (!search) return true;
      const haystack = [
        row.systemName,
        row.systemId ?? "",
        row.trackingSystemRefId,
        row.monitoring,
        row.monitoringSystemId,
        row.monitoringSystemName,
        row.installerName,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    });

    rows.sort((a, b) => {
      const direction = performanceRatioSortDir === "asc" ? 1 : -1;
      if (performanceRatioSortBy === "systemName") {
        return (
          a.systemName.localeCompare(b.systemName, undefined, {
            sensitivity: "base",
            numeric: true,
          }) * direction
        );
      }
      if (performanceRatioSortBy === "readDate") {
        const aValue = a.readDate?.getTime() ?? Number.NEGATIVE_INFINITY;
        const bValue = b.readDate?.getTime() ?? Number.NEGATIVE_INFINITY;
        if (aValue === bValue) {
          return (
            a.systemName.localeCompare(b.systemName, undefined, {
              sensitivity: "base",
              numeric: true,
            }) * direction
          );
        }
        return (aValue - bValue) * direction;
      }

      const aValue =
        a[performanceRatioSortBy] ?? Number.NEGATIVE_INFINITY;
      const bValue =
        b[performanceRatioSortBy] ?? Number.NEGATIVE_INFINITY;
      if (aValue === bValue) {
        return (
          a.systemName.localeCompare(b.systemName, undefined, {
            sensitivity: "base",
            numeric: true,
          }) * direction
        );
      }
      return ((aValue as number) - (bValue as number)) * direction;
    });

    return rows;
  }, [
    deferredPerformanceRatioSearch,
    performanceRatioResult.rows,
    performanceRatioMonitoringFilter,
    performanceRatioMatchFilter,
    performanceRatioSortBy,
    performanceRatioSortDir,
  ]);

  const performanceRatioTotalPages = Math.max(
    1,
    Math.ceil(
      filteredPerformanceRatioRows.length / PERFORMANCE_RATIO_PAGE_SIZE,
    ),
  );
  const performanceRatioCurrentPage = Math.min(
    performanceRatioPage,
    performanceRatioTotalPages,
  );
  const performanceRatioPageStartIndex =
    (performanceRatioCurrentPage - 1) * PERFORMANCE_RATIO_PAGE_SIZE;
  const performanceRatioPageEndIndex =
    performanceRatioPageStartIndex + PERFORMANCE_RATIO_PAGE_SIZE;
  const visiblePerformanceRatioRows = useMemo(
    () =>
      filteredPerformanceRatioRows.slice(
        performanceRatioPageStartIndex,
        performanceRatioPageEndIndex,
      ),
    [
      filteredPerformanceRatioRows,
      performanceRatioPageEndIndex,
      performanceRatioPageStartIndex,
    ],
  );

  useEffect(() => {
    setPerformanceRatioPage(1);
  }, [
    performanceRatioMonitoringFilter,
    performanceRatioMatchFilter,
    performanceRatioSortBy,
    performanceRatioSortDir,
    performanceRatioSearch,
  ]);

  useEffect(() => {
    if (performanceRatioPage <= performanceRatioTotalPages) return;
    setPerformanceRatioPage(performanceRatioTotalPages);
  }, [performanceRatioPage, performanceRatioTotalPages]);

  const performanceRatioSummary = useMemo(() => {
    const rows = performanceRatioResult.rows;
    const withBaseline = rows.filter(
      (row) => row.baselineReadWh !== null,
    ).length;
    const withExpected = rows.filter(
      (row) =>
        row.expectedProductionWh !== null && row.expectedProductionWh > 0,
    ).length;
    const withRatio = rows.filter(
      (row) => row.performanceRatioPercent !== null,
    ).length;
    const totalDeltaWh = rows.reduce(
      (sum, row) => sum + (row.productionDeltaWh ?? 0),
      0,
    );
    const totalExpectedWh = rows.reduce(
      (sum, row) => sum + (row.expectedProductionWh ?? 0),
      0,
    );
    const totalContractValue = rows.reduce(
      (sum, row) => sum + row.contractValue,
      0,
    );

    return {
      convertedReadCount: performanceRatioResult.convertedReadCount,
      matchedConvertedReads: performanceRatioResult.matchedConvertedReads,
      unmatchedConvertedReads: performanceRatioResult.unmatchedConvertedReads,
      invalidConvertedReads: performanceRatioResult.invalidConvertedReads,
      allocationCount: rows.length,
      withBaseline,
      withExpected,
      withRatio,
      totalDeltaWh,
      totalExpectedWh,
      portfolioRatioPercent: toPercentValue(totalDeltaWh, totalExpectedWh),
      totalContractValue,
    };
  }, [performanceRatioResult]);

  // -------------------------------------------------------------------------
  // Compliant sources section
  // -------------------------------------------------------------------------
  const compliantSourceByPortalId = useMemo(() => {
    const mapping = new Map<string, CompliantSourceEntry>();
    compliantSourceEntries.forEach((entry) => {
      if (!entry.portalId) return;
      mapping.set(entry.portalId, entry);
    });
    return mapping;
  }, [compliantSourceEntries]);

  const autoCompliantSourceByPortalId = useMemo(() => {
    const mapping = new Map<string, string>();
    performanceRatioResult.rows.forEach((row) => {
      if (!row.systemId) return;
      const monitoringPlatformCompliantSource =
        resolveMonitoringPlatformCompliantSource(row.monitoringPlatform);
      const isTenKwCompliant = isTenKwAcOrLess(
        row.portalAcSizeKw,
        row.abpAcSizeKw,
      );
      const candidateSource =
        monitoringPlatformCompliantSource ??
        (isTenKwCompliant ? TEN_KW_COMPLIANT_SOURCE : null);
      if (!candidateSource) return;

      const existingSource = mapping.get(row.systemId);
      if (
        !existingSource ||
        getAutoCompliantSourcePriority(candidateSource) >
          getAutoCompliantSourcePriority(existingSource)
      ) {
        mapping.set(row.systemId, candidateSource);
      }
    });
    return mapping;
  }, [performanceRatioResult.rows]);

  const compliantSourcesTableRows = useMemo<CompliantSourceTableRow[]>(() => {
    const mapping = new Map<string, CompliantSourceTableRow>();

    autoCompliantSourceByPortalId.forEach((compliantSource, portalId) => {
      mapping.set(portalId, {
        portalId,
        compliantSource,
        updatedAt: null,
        evidence: [],
        sourceType: "Auto",
      });
    });

    compliantSourceEntries.forEach((entry) => {
      if (!entry.portalId) return;
      mapping.set(entry.portalId, {
        portalId: entry.portalId,
        compliantSource: entry.compliantSource,
        updatedAt: entry.updatedAt,
        evidence: entry.evidence,
        sourceType: "Manual",
      });
    });

    return Array.from(mapping.values()).sort((a, b) => {
      if (a.sourceType !== b.sourceType)
        return a.sourceType === "Manual" ? -1 : 1;
      const aUpdated = a.updatedAt?.getTime() ?? 0;
      const bUpdated = b.updatedAt?.getTime() ?? 0;
      if (aUpdated !== bUpdated) return bUpdated - aUpdated;
      return a.portalId.localeCompare(b.portalId, undefined, {
        sensitivity: "base",
        numeric: true,
      });
    });
  }, [autoCompliantSourceByPortalId, compliantSourceEntries]);

  const compliantSourceTotalPages = Math.max(
    1,
    Math.ceil(compliantSourcesTableRows.length / COMPLIANT_SOURCE_PAGE_SIZE),
  );
  const compliantSourceCurrentPage = Math.min(
    compliantSourcePage,
    compliantSourceTotalPages,
  );
  const compliantSourcePageStartIndex =
    (compliantSourceCurrentPage - 1) * COMPLIANT_SOURCE_PAGE_SIZE;
  const compliantSourcePageEndIndex =
    compliantSourcePageStartIndex + COMPLIANT_SOURCE_PAGE_SIZE;
  const visibleCompliantSourceEntries = useMemo(
    () =>
      compliantSourcesTableRows.slice(
        compliantSourcePageStartIndex,
        compliantSourcePageEndIndex,
      ),
    [
      compliantSourcePageEndIndex,
      compliantSourcePageStartIndex,
      compliantSourcesTableRows,
    ],
  );

  useEffect(() => {
    if (compliantSourcePage <= compliantSourceTotalPages) return;
    setCompliantSourcePage(compliantSourceTotalPages);
  }, [compliantSourcePage, compliantSourceTotalPages]);

  const compliantPerformanceRatioRows = useMemo<
    CompliantPerformanceRatioRow[]
  >(() => {
    const eligibleRows = performanceRatioResult.rows.filter((row) => {
      if (!row.part2VerificationDate) return false;
      if (row.performanceRatioPercent === null) return false;
      return (
        row.performanceRatioPercent >= 30 &&
        row.performanceRatioPercent <= 150
      );
    });

    const bestBySystem = new Map<string, CompliantPerformanceRatioRow>();

    eligibleRows.forEach((row) => {
      const systemKey =
        row.stateApplicationRefId ||
        row.systemId ||
        row.trackingSystemRefId ||
        row.systemName.toLowerCase();
      const compliantEntry = row.systemId
        ? compliantSourceByPortalId.get(row.systemId)
        : undefined;
      const rowAutoCompliantSource =
        resolveMonitoringPlatformCompliantSource(row.monitoringPlatform) ??
        (isTenKwAcOrLess(row.portalAcSizeKw, row.abpAcSizeKw)
          ? TEN_KW_COMPLIANT_SOURCE
          : null);
      const autoCompliantSource =
        rowAutoCompliantSource ??
        (row.systemId
          ? autoCompliantSourceByPortalId.get(row.systemId)
          : undefined);
      const readWindowMonthYear = row.readDate
        ? formatMonthYear(toReadWindowMonthStart(row.readDate))
        : "N/A";
      const candidate: CompliantPerformanceRatioRow = {
        ...row,
        compliantSource:
          compliantEntry?.compliantSource ?? autoCompliantSource ?? null,
        evidenceCount: compliantEntry?.evidence.length ?? 0,
        meterReadMonthYear: formatMonthYear(row.readDate),
        readWindowMonthYear,
      };

      const existing = bestBySystem.get(systemKey);
      if (!existing) {
        bestBySystem.set(systemKey, candidate);
        return;
      }
      const candidateWindowTime = candidate.readDate
        ? toReadWindowMonthStart(candidate.readDate).getTime()
        : Number.NEGATIVE_INFINITY;
      const existingWindowTime = existing.readDate
        ? toReadWindowMonthStart(existing.readDate).getTime()
        : Number.NEGATIVE_INFINITY;
      if (candidateWindowTime > existingWindowTime) {
        bestBySystem.set(systemKey, candidate);
        return;
      }
      if (candidateWindowTime === existingWindowTime) {
        const candidateRatio =
          candidate.performanceRatioPercent ?? Number.NEGATIVE_INFINITY;
        const existingRatio =
          existing.performanceRatioPercent ?? Number.NEGATIVE_INFINITY;
        if (candidateRatio > existingRatio) {
          bestBySystem.set(systemKey, candidate);
          return;
        }
        if (candidateRatio === existingRatio) {
          const candidateReadTime =
            candidate.readDate?.getTime() ?? Number.NEGATIVE_INFINITY;
          const existingReadTime =
            existing.readDate?.getTime() ?? Number.NEGATIVE_INFINITY;
          if (candidateReadTime > existingReadTime) {
            bestBySystem.set(systemKey, candidate);
          }
        }
      }
    });

    return Array.from(bestBySystem.values()).sort((a, b) => {
      const readWindowTimeDiff =
        (b.readDate
          ? toReadWindowMonthStart(b.readDate).getTime()
          : Number.NEGATIVE_INFINITY) -
        (a.readDate
          ? toReadWindowMonthStart(a.readDate).getTime()
          : Number.NEGATIVE_INFINITY);
      if (readWindowTimeDiff !== 0) return readWindowTimeDiff;
      const ratioDiff =
        (b.performanceRatioPercent ?? Number.NEGATIVE_INFINITY) -
        (a.performanceRatioPercent ?? Number.NEGATIVE_INFINITY);
      if (ratioDiff !== 0) return ratioDiff;
      return a.systemName.localeCompare(b.systemName, undefined, {
        sensitivity: "base",
        numeric: true,
      });
    });
  }, [
    autoCompliantSourceByPortalId,
    compliantSourceByPortalId,
    performanceRatioResult.rows,
  ]);

  const compliantPerformanceRatioSummary = useMemo(() => {
    const rows = compliantPerformanceRatioRows;
    const withCompliantSource = rows.filter(
      (row) => !!row.compliantSource,
    ).length;
    const withEvidence = rows.filter((row) => row.evidenceCount > 0).length;
    return {
      count: rows.length,
      withCompliantSource,
      withEvidence,
    };
  }, [compliantPerformanceRatioRows]);

  const compliantReportTotalPages = Math.max(
    1,
    Math.ceil(compliantPerformanceRatioRows.length / COMPLIANT_REPORT_PAGE_SIZE),
  );
  const compliantReportCurrentPage = Math.min(
    compliantReportPage,
    compliantReportTotalPages,
  );
  const compliantReportPageStartIndex =
    (compliantReportCurrentPage - 1) * COMPLIANT_REPORT_PAGE_SIZE;
  const compliantReportPageEndIndex =
    compliantReportPageStartIndex + COMPLIANT_REPORT_PAGE_SIZE;
  const visibleCompliantPerformanceRows = useMemo(
    () =>
      compliantPerformanceRatioRows.slice(
        compliantReportPageStartIndex,
        compliantReportPageEndIndex,
      ),
    [
      compliantPerformanceRatioRows,
      compliantReportPageEndIndex,
      compliantReportPageStartIndex,
    ],
  );

  useEffect(() => {
    if (compliantReportPage <= compliantReportTotalPages) return;
    setCompliantReportPage(compliantReportTotalPages);
  }, [compliantReportPage, compliantReportTotalPages]);

  // -------------------------------------------------------------------------
  // Callbacks: save / remove / import compliant-source entries
  // -------------------------------------------------------------------------
  const saveCompliantSourceEntry = useCallback(() => {
    const portalId = clean(compliantSourcePortalIdInput);
    const compliantSource = clean(compliantSourceTextInput);
    if (!portalId) {
      setCompliantSourceUploadError("Portal ID is required.");
      return;
    }
    if (!isValidCompliantSourceText(compliantSource)) {
      setCompliantSourceUploadError(
        `Compliant Source must contain only letters, numbers, spaces, underscores, hyphens, or commas, and be ${MAX_COMPLIANT_SOURCE_CHARS} characters or fewer.`,
      );
      return;
    }

    const invalidFile = compliantSourceEvidenceFiles.find((file) => {
      const isPdf =
        file.type === "application/pdf" ||
        file.name.toLowerCase().endsWith(".pdf");
      const isImage = file.type.startsWith("image/");
      return !isPdf && !isImage;
    });
    if (invalidFile) {
      setCompliantSourceUploadError(
        "Evidence uploads support only images and PDFs.",
      );
      return;
    }

    const oversizedFile = compliantSourceEvidenceFiles.find(
      (file) => file.size > MAX_COMPLIANT_FILE_BYTES,
    );
    if (oversizedFile) {
      setCompliantSourceUploadError(
        `${oversizedFile.name} is too large. Max file size is ${formatNumber(
          MAX_COMPLIANT_FILE_BYTES / 1024 / 1024,
        )} MB.`,
      );
      return;
    }

    const now = new Date();
    const newEvidence: CompliantSourceEvidence[] =
      compliantSourceEvidenceFiles.map((file) => ({
        id: createLogId(),
        fileName: file.name,
        fileType: file.type || "application/octet-stream",
        fileSizeBytes: file.size,
        objectUrl: URL.createObjectURL(file),
        uploadedAt: now,
      }));

    setCompliantSourceEntries((previous) => {
      const existing = previous.find((entry) => entry.portalId === portalId);
      if (!existing) {
        return [
          ...previous,
          {
            portalId,
            compliantSource,
            updatedAt: now,
            evidence: newEvidence,
          },
        ];
      }
      return previous.map((entry) =>
        entry.portalId === portalId
          ? {
              ...entry,
              compliantSource,
              updatedAt: now,
              evidence: [...entry.evidence, ...newEvidence],
            }
          : entry,
      );
    });

    setCompliantSourceUploadError(null);
    setCompliantSourceTextInput("");
    setCompliantSourceEvidenceFiles([]);
  }, [
    compliantSourceEvidenceFiles,
    compliantSourcePortalIdInput,
    compliantSourceTextInput,
  ]);

  const removeCompliantSourceEntry = useCallback((portalId: string) => {
    setCompliantSourceEntries((previous) => {
      const target = previous.find((entry) => entry.portalId === portalId);
      target?.evidence.forEach((item) => URL.revokeObjectURL(item.objectUrl));
      return previous.filter((entry) => entry.portalId !== portalId);
    });
  }, []);

  const importCompliantSourceCsv = useCallback(
    async (file: File | null) => {
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = parseCsv(text);
        if (
          !matchesExpectedHeaders(parsed.headers, ["portal_id", "source"])
        ) {
          setCompliantSourceUploadError(
            "CSV must include headers: portal_id, source",
          );
          setCompliantSourceCsvMessage(null);
          return;
        }

        const importedAt = new Date();
        const validRows: Array<{ portalId: string; source: string }> = [];
        let skippedMissing = 0;
        let skippedInvalid = 0;

        parsed.rows.forEach((row) => {
          const portalId = getCsvValueByHeader(row, "portal_id");
          const source = getCsvValueByHeader(row, "source");
          if (!portalId || !source) {
            skippedMissing += 1;
            return;
          }
          if (!isValidCompliantSourceText(source)) {
            skippedInvalid += 1;
            return;
          }
          validRows.push({ portalId, source });
        });

        if (validRows.length === 0) {
          setCompliantSourceUploadError(
            "No valid compliant source rows found in CSV.",
          );
          setCompliantSourceCsvMessage(null);
          return;
        }

        setCompliantSourceEntries((previous) => {
          const byPortal = new Map(
            previous.map((entry) => [entry.portalId, entry]),
          );
          validRows.forEach(({ portalId, source }) => {
            const existing = byPortal.get(portalId);
            if (existing) {
              byPortal.set(portalId, {
                ...existing,
                compliantSource: source,
                updatedAt: importedAt,
              });
            } else {
              byPortal.set(portalId, {
                portalId,
                compliantSource: source,
                updatedAt: importedAt,
                evidence: [],
              });
            }
          });
          return Array.from(byPortal.values());
        });

        setCompliantSourceUploadError(null);
        setCompliantSourceCsvMessage(
          `Imported ${formatNumber(
            validRows.length,
          )} row(s). Skipped ${formatNumber(
            skippedMissing,
          )} missing and ${formatNumber(skippedInvalid)} invalid source row(s).`,
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Could not import compliant source CSV.";
        setCompliantSourceUploadError(message);
        setCompliantSourceCsvMessage(null);
      }
    },
    [],
  );

  // -------------------------------------------------------------------------
  // CSV download callbacks
  // -------------------------------------------------------------------------
  const downloadPerformanceRatioCsv = useCallback(() => {
    const headers = [
      "system_name",
      "nonid",
      "portal_id",
      "state_certification_number",
      "csg_portal_ac_size_kw",
      "abp_report_ac_size_kw",
      "abp_part_2_verification_date",
      "installer_name",
      "monitoring_platform",
      "monitoring",
      "monitoring_system_id",
      "monitoring_system_name",
      "match_type",
      "read_date",
      "meter_read_month_year",
      "read_window_month_year",
      "baseline_date",
      "baseline_source",
      "lifetime_read_wh",
      "baseline_read_wh",
      "production_delta_wh",
      "expected_production_wh",
      "performance_ratio_percent",
      "contract_value",
    ];

    const rows = filteredPerformanceRatioRows.map((row) => ({
      system_name: row.systemName,
      nonid: row.trackingSystemRefId,
      portal_id: row.systemId ?? "",
      state_certification_number: row.stateApplicationRefId ?? "",
      csg_portal_ac_size_kw: row.portalAcSizeKw ?? "",
      abp_report_ac_size_kw: row.abpAcSizeKw ?? "",
      abp_part_2_verification_date: row.part2VerificationDate
        ? row.part2VerificationDate.toISOString().slice(0, 10)
        : "",
      installer_name: row.installerName,
      monitoring_platform: row.monitoringPlatform,
      monitoring: row.monitoring,
      monitoring_system_id: row.monitoringSystemId,
      monitoring_system_name: row.monitoringSystemName,
      match_type: row.matchType,
      read_date: row.readDate
        ? row.readDate.toISOString().slice(0, 10)
        : row.readDateRaw,
      meter_read_month_year: formatMonthYear(row.readDate),
      read_window_month_year: row.readDate
        ? formatMonthYear(toReadWindowMonthStart(row.readDate))
        : "N/A",
      baseline_date: row.baselineDate
        ? row.baselineDate.toISOString().slice(0, 10)
        : "",
      baseline_source: row.baselineSource ?? "",
      lifetime_read_wh: row.lifetimeReadWh ?? "",
      baseline_read_wh: row.baselineReadWh ?? "",
      production_delta_wh: row.productionDeltaWh ?? "",
      expected_production_wh: row.expectedProductionWh ?? "",
      performance_ratio_percent: row.performanceRatioPercent ?? "",
      contract_value: row.contractValue,
    }));

    const csv = buildCsv(headers, rows);
    const fileName = `performance-ratio-${new Date()
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
  }, [filteredPerformanceRatioRows]);

  const downloadCompliantPerformanceRatioCsv = useCallback(() => {
    const headers = [
      "system_name",
      "nonid",
      "portal_id",
      "state_certification_number",
      "csg_portal_ac_size_kw",
      "abp_report_ac_size_kw",
      "abp_part_2_verification_date",
      "installer_name",
      "monitoring_platform",
      "monitoring",
      "monitoring_system_id",
      "monitoring_system_name",
      "match_type",
      "read_date",
      "meter_read_month_year",
      "read_window_month_year",
      "baseline_date",
      "baseline_source",
      "lifetime_read_wh",
      "baseline_read_wh",
      "production_delta_wh",
      "expected_production_wh",
      "performance_ratio_percent",
      "contract_value",
      "compliant_source",
      "compliant_evidence_count",
    ];

    const rows = compliantPerformanceRatioRows.map((row) => ({
      system_name: row.systemName,
      nonid: row.trackingSystemRefId,
      portal_id: row.systemId ?? "",
      state_certification_number: row.stateApplicationRefId ?? "",
      csg_portal_ac_size_kw: row.portalAcSizeKw ?? "",
      abp_report_ac_size_kw: row.abpAcSizeKw ?? "",
      abp_part_2_verification_date: row.part2VerificationDate
        ? row.part2VerificationDate.toISOString().slice(0, 10)
        : "",
      installer_name: row.installerName,
      monitoring_platform: row.monitoringPlatform,
      monitoring: row.monitoring,
      monitoring_system_id: row.monitoringSystemId,
      monitoring_system_name: row.monitoringSystemName,
      match_type: row.matchType,
      read_date: row.readDate
        ? row.readDate.toISOString().slice(0, 10)
        : row.readDateRaw,
      meter_read_month_year: row.meterReadMonthYear,
      read_window_month_year: row.readWindowMonthYear,
      baseline_date: row.baselineDate
        ? row.baselineDate.toISOString().slice(0, 10)
        : "",
      baseline_source: row.baselineSource ?? "",
      lifetime_read_wh: row.lifetimeReadWh ?? "",
      baseline_read_wh: row.baselineReadWh ?? "",
      production_delta_wh: row.productionDeltaWh ?? "",
      expected_production_wh: row.expectedProductionWh ?? "",
      performance_ratio_percent: row.performanceRatioPercent ?? "",
      contract_value: row.contractValue,
      compliant_source: row.compliantSource ?? "",
      compliant_evidence_count: row.evidenceCount,
    }));

    const csv = buildCsv(headers, rows);
    const fileName = `performance-ratio-compliant-${new Date()
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
  }, [compliantPerformanceRatioRows]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Converted Reads Performance Ratio
          </CardTitle>
          <CardDescription>
            Matches converted reads to ABP Part II verified portal systems
            using monitoring + system ID, monitoring + system name, or
            monitoring + both. Performance Ratio = production delta from
            baseline / expected production over the same period. If no GATS
            baseline exists, optional Generator Details upload is used as
            fallback (Date Online month/year assumed day 15, baseline meter
            read = 0).
          </CardDescription>
        </CardHeader>
      </Card>

      {!hasConvertedReads || !hasAnnualProductionEstimates ? (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardHeader>
            <CardTitle className="text-base text-amber-900">
              Missing Files for Performance Ratio
            </CardTitle>
            <CardDescription className="text-amber-800">
              Upload these files in Step 1:{" "}
              {[
                !hasConvertedReads ? convertedReadsLabel : null,
                !hasAnnualProductionEstimates
                  ? annualProductionEstimatesLabel
                  : null,
              ]
                .filter((value): value is string => value !== null)
                .join(", ")}
              .
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-7">
            <Card>
              <CardHeader>
                <CardDescription>Converted Read Rows</CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(performanceRatioSummary.convertedReadCount)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Matched Read Rows</CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(
                    performanceRatioSummary.matchedConvertedReads,
                  )}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Unmatched Read Rows</CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(
                    performanceRatioSummary.unmatchedConvertedReads,
                  )}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Allocations (Read-to-System)</CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(performanceRatioSummary.allocationCount)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Portfolio Performance Ratio</CardDescription>
                <CardTitle className="text-2xl">
                  {formatPercent(performanceRatioSummary.portfolioRatioPercent)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Total Delta Production (kWh)</CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(performanceRatioSummary.totalDeltaWh / 1_000)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>
                  Total Expected Production (kWh)
                </CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(
                    performanceRatioSummary.totalExpectedWh / 1_000,
                  )}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Performance Ratio Filters
              </CardTitle>
              <CardDescription>
                Expected production uses Annual Production Estimates monthly
                values, prorated by days when the read window starts/ends
                mid-month.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">
                  Monitoring
                </label>
                <select
                  className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                  value={performanceRatioMonitoringFilter}
                  onChange={(event) =>
                    setPerformanceRatioMonitoringFilter(event.target.value)
                  }
                >
                  <option value="All">All Monitoring</option>
                  {performanceRatioMonitoringOptions.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">
                  Match Type
                </label>
                <select
                  className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                  value={performanceRatioMatchFilter}
                  onChange={(event) =>
                    setPerformanceRatioMatchFilter(
                      event.target.value as PerformanceRatioMatchType | "All",
                    )
                  }
                >
                  <option value="All">All Match Types</option>
                  <option value="Monitoring + System ID + System Name">
                    Monitoring + System ID + System Name
                  </option>
                  <option value="Monitoring + System ID">
                    Monitoring + System ID
                  </option>
                  <option value="Monitoring + System Name">
                    Monitoring + System Name
                  </option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">
                  Sort by
                </label>
                <select
                  className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                  value={performanceRatioSortBy}
                  onChange={(event) =>
                    setPerformanceRatioSortBy(
                      event.target.value as
                        | "performanceRatioPercent"
                        | "productionDeltaWh"
                        | "expectedProductionWh"
                        | "systemName"
                        | "readDate",
                    )
                  }
                >
                  <option value="performanceRatioPercent">
                    Performance Ratio
                  </option>
                  <option value="productionDeltaWh">Production Delta</option>
                  <option value="expectedProductionWh">
                    Expected Production
                  </option>
                  <option value="readDate">Read Date</option>
                  <option value="systemName">System Name</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">
                  Direction
                </label>
                <select
                  className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                  value={performanceRatioSortDir}
                  onChange={(event) =>
                    setPerformanceRatioSortDir(
                      event.target.value as "asc" | "desc",
                    )
                  }
                >
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              </div>

              <div className="space-y-1 xl:col-span-2">
                <label className="text-sm font-medium text-slate-700">
                  Search
                </label>
                <Input
                  placeholder="System name, NONID, monitoring system id/name, installer..."
                  value={performanceRatioSearch}
                  onChange={(event) =>
                    setPerformanceRatioSearch(event.target.value)
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">
                    Performance Ratio Allocation Detail
                  </CardTitle>
                  <CardDescription>
                    Each row is one converted read allocated to one matching
                    portal project. Showing rows{" "}
                    {filteredPerformanceRatioRows.length === 0
                      ? "0"
                      : formatNumber(performanceRatioPageStartIndex + 1)}
                    -
                    {formatNumber(
                      Math.min(
                        performanceRatioPageEndIndex,
                        filteredPerformanceRatioRows.length,
                      ),
                    )}{" "}
                    of {formatNumber(filteredPerformanceRatioRows.length)}.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPerformanceRatioPage((page) => Math.max(1, page - 1))
                    }
                    disabled={performanceRatioCurrentPage <= 1}
                  >
                    Previous
                  </Button>
                  <p className="text-xs text-slate-600">
                    Page {formatNumber(performanceRatioCurrentPage)} of{" "}
                    {formatNumber(performanceRatioTotalPages)}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPerformanceRatioPage((page) =>
                        Math.min(performanceRatioTotalPages, page + 1),
                      )
                    }
                    disabled={
                      performanceRatioCurrentPage >= performanceRatioTotalPages
                    }
                  >
                    Next
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={downloadPerformanceRatioCsv}
                  >
                    Download Performance Ratio CSV
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>System</TableHead>
                    <TableHead>NONID</TableHead>
                    <TableHead>Portal ID</TableHead>
                    <TableHead>Monitoring</TableHead>
                    <TableHead>Match Type</TableHead>
                    <TableHead>Read Date</TableHead>
                    <TableHead>Baseline Date</TableHead>
                    <TableHead>Baseline Source</TableHead>
                    <TableHead>Read (kWh)</TableHead>
                    <TableHead>Delta (kWh)</TableHead>
                    <TableHead>Expected (kWh)</TableHead>
                    <TableHead>Performance Ratio</TableHead>
                    <TableHead>Contract Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visiblePerformanceRatioRows.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell className="font-medium">
                        {row.systemName}
                      </TableCell>
                      <TableCell>{row.trackingSystemRefId}</TableCell>
                      <TableCell>{row.systemId ?? "N/A"}</TableCell>
                      <TableCell>{row.monitoring}</TableCell>
                      <TableCell>{row.matchType}</TableCell>
                      <TableCell>
                        {row.readDate
                          ? formatDate(row.readDate)
                          : row.readDateRaw || "N/A"}
                      </TableCell>
                      <TableCell>{formatDate(row.baselineDate)}</TableCell>
                      <TableCell>{row.baselineSource ?? "N/A"}</TableCell>
                      <TableCell>
                        {formatNumber(
                          row.lifetimeReadWh !== null
                            ? row.lifetimeReadWh / 1_000
                            : null,
                        )}
                      </TableCell>
                      <TableCell>
                        {row.productionDeltaWh === null
                          ? "N/A"
                          : formatSignedNumber(row.productionDeltaWh / 1_000)}
                      </TableCell>
                      <TableCell>
                        {formatNumber(
                          row.expectedProductionWh !== null
                            ? row.expectedProductionWh / 1_000
                            : null,
                        )}
                      </TableCell>
                      <TableCell
                        className={
                          row.performanceRatioPercent !== null &&
                          row.performanceRatioPercent < 100
                            ? "text-amber-700 font-medium"
                            : ""
                        }
                      >
                        {formatPercent(row.performanceRatioPercent)}
                      </TableCell>
                      <TableCell>
                        {formatCurrency(row.contractValue)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Compliant Sources</CardTitle>
              <CardDescription>
                Tie a compliant-source string (max 100 chars: letters, numbers,
                spaces, underscores, hyphens, commas) and optional image/PDF
                evidence to a portal ID. Auto sources are also listed when
                monitoring platform is compliant (Enphase, AlsoEnergy,
                Solar-Log, SDSI Arraymeter, Locus Energy, Vision Metering,
                SenseRGM) or when both AC sizes are 10kW AC or less.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-white">
                    <Upload className="h-4 w-4" />
                    Upload Compliant Source CSV
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        void importCompliantSourceCsv(file);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                  <p className="text-xs text-slate-600">
                    Required headers: `portal_id`, `source`
                  </p>
                </div>
                {compliantSourceCsvMessage ? (
                  <p className="mt-2 text-xs text-emerald-700">
                    {compliantSourceCsvMessage}
                  </p>
                ) : null}
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">
                    Portal ID
                  </label>
                  <Input
                    value={compliantSourcePortalIdInput}
                    onChange={(event) =>
                      setCompliantSourcePortalIdInput(event.target.value)
                    }
                    placeholder="e.g. 107313"
                  />
                </div>
                <div className="space-y-1 md:col-span-2">
                  <label className="text-sm font-medium text-slate-700">
                    Compliant Source
                  </label>
                  <Input
                    value={compliantSourceTextInput}
                    onChange={(event) =>
                      setCompliantSourceTextInput(
                        event.target.value.slice(0, MAX_COMPLIANT_SOURCE_CHARS),
                      )
                    }
                    placeholder="Letters, numbers, spaces, underscores, hyphens, commas"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                  <Upload className="h-4 w-4" />
                  Upload Evidence (Image/PDF)
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      setCompliantSourceEvidenceFiles(files);
                    }}
                  />
                </label>
                <p className="text-xs text-slate-500">
                  {compliantSourceEvidenceFiles.length > 0
                    ? `${formatNumber(
                        compliantSourceEvidenceFiles.length,
                      )} file(s) selected`
                    : "No evidence files selected"}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={saveCompliantSourceEntry}
                >
                  Save Compliant Source
                </Button>
              </div>

              {compliantSourceUploadError ? (
                <p className="text-sm text-rose-700">
                  {compliantSourceUploadError}
                </p>
              ) : null}

              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-slate-600">
                  Showing rows{" "}
                  {compliantSourcesTableRows.length === 0
                    ? "0"
                    : formatNumber(compliantSourcePageStartIndex + 1)}
                  -
                  {formatNumber(
                    Math.min(
                      compliantSourcePageEndIndex,
                      compliantSourcesTableRows.length,
                    ),
                  )}{" "}
                  of {formatNumber(compliantSourcesTableRows.length)}.
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setCompliantSourcePage((page) => Math.max(1, page - 1))
                    }
                    disabled={compliantSourceCurrentPage <= 1}
                  >
                    Previous
                  </Button>
                  <p className="text-xs text-slate-600">
                    Page {formatNumber(compliantSourceCurrentPage)} of{" "}
                    {formatNumber(compliantSourceTotalPages)}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setCompliantSourcePage((page) =>
                        Math.min(compliantSourceTotalPages, page + 1),
                      )
                    }
                    disabled={
                      compliantSourceCurrentPage >= compliantSourceTotalPages
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Portal ID</TableHead>
                      <TableHead>Compliant Source</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Evidence</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {compliantSourcesTableRows.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="text-center text-slate-500"
                        >
                          No compliant sources available yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      visibleCompliantSourceEntries.map((entry) => (
                        <TableRow key={`${entry.sourceType}-${entry.portalId}`}>
                          <TableCell className="font-medium">
                            {entry.portalId}
                          </TableCell>
                          <TableCell>{entry.compliantSource}</TableCell>
                          <TableCell>{entry.sourceType}</TableCell>
                          <TableCell>
                            {entry.evidence.length === 0 ? (
                              <span className="text-slate-500">No files</span>
                            ) : (
                              <div className="flex flex-wrap gap-2">
                                {entry.evidence.map((item) => (
                                  <a
                                    key={item.id}
                                    href={item.objectUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-xs text-blue-700 underline"
                                  >
                                    {item.fileName}
                                  </a>
                                ))}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {entry.updatedAt
                              ? formatDate(entry.updatedAt)
                              : "Auto"}
                          </TableCell>
                          <TableCell>
                            {entry.sourceType === "Manual" ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  removeCompliantSourceEntry(entry.portalId)
                                }
                              >
                                Remove
                              </Button>
                            ) : (
                              <span className="text-xs text-slate-500">
                                Auto
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">
                    Compliant Performance Ratio Report
                  </CardTitle>
                  <CardDescription>
                    Same report logic, but only systems with Part II
                    verification dates and performance ratio between 30% and
                    150% (inclusive). If multiple reads qualify, the newest
                    read window (16th to 15th) is selected first; within that
                    window, the highest ratio per system is kept.
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={downloadCompliantPerformanceRatioCsv}
                >
                  Download Compliant Report CSV
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">
                    Systems in Compliant Report
                  </p>
                  <p className="text-xl font-semibold text-slate-900">
                    {formatNumber(compliantPerformanceRatioSummary.count)}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">
                    With Compliant Source Text
                  </p>
                  <p className="text-xl font-semibold text-slate-900">
                    {formatNumber(
                      compliantPerformanceRatioSummary.withCompliantSource,
                    )}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">With Evidence Files</p>
                  <p className="text-xl font-semibold text-slate-900">
                    {formatNumber(
                      compliantPerformanceRatioSummary.withEvidence,
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-slate-600">
                  Showing rows{" "}
                  {compliantPerformanceRatioRows.length === 0
                    ? "0"
                    : formatNumber(compliantReportPageStartIndex + 1)}
                  -
                  {formatNumber(
                    Math.min(
                      compliantReportPageEndIndex,
                      compliantPerformanceRatioRows.length,
                    ),
                  )}{" "}
                  of {formatNumber(compliantPerformanceRatioRows.length)}.
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setCompliantReportPage((page) => Math.max(1, page - 1))
                    }
                    disabled={compliantReportCurrentPage <= 1}
                  >
                    Previous
                  </Button>
                  <p className="text-xs text-slate-600">
                    Page {formatNumber(compliantReportCurrentPage)} of{" "}
                    {formatNumber(compliantReportTotalPages)}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setCompliantReportPage((page) =>
                        Math.min(compliantReportTotalPages, page + 1),
                      )
                    }
                    disabled={
                      compliantReportCurrentPage >= compliantReportTotalPages
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>System</TableHead>
                    <TableHead>NONID</TableHead>
                    <TableHead>Portal ID</TableHead>
                    <TableHead>Part II Verified</TableHead>
                    <TableHead>Read Date</TableHead>
                    <TableHead>Meter Read Month</TableHead>
                    <TableHead>Read Window Month</TableHead>
                    <TableHead>Performance Ratio</TableHead>
                    <TableHead>Compliant Source</TableHead>
                    <TableHead>Evidence Files</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {compliantPerformanceRatioRows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={10}
                        className="text-center text-slate-500"
                      >
                        No systems currently meet the compliant report criteria.
                      </TableCell>
                    </TableRow>
                  ) : (
                    visibleCompliantPerformanceRows.map((row) => (
                      <TableRow key={`compliant-${row.key}`}>
                        <TableCell className="font-medium">
                          {row.systemName}
                        </TableCell>
                        <TableCell>{row.trackingSystemRefId}</TableCell>
                        <TableCell>{row.systemId ?? "N/A"}</TableCell>
                        <TableCell>
                          {formatDate(row.part2VerificationDate)}
                        </TableCell>
                        <TableCell>
                          {row.readDate
                            ? formatDate(row.readDate)
                            : row.readDateRaw || "N/A"}
                        </TableCell>
                        <TableCell>{row.meterReadMonthYear}</TableCell>
                        <TableCell>{row.readWindowMonthYear}</TableCell>
                        <TableCell>
                          {formatPercent(row.performanceRatioPercent)}
                        </TableCell>
                        <TableCell>{row.compliantSource ?? "N/A"}</TableCell>
                        <TableCell>{formatNumber(row.evidenceCount)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      <AskAiPanel
        moduleKey="solar-rec-performance-ratio"
        title="Ask AI about Performance Ratio"
        contextGetter={() => ({
          inputs: {
            convertedReadsProvided: hasConvertedReads,
            annualProductionEstimatesProvided: hasAnnualProductionEstimates,
            // Salvage PR B — `generatorDetailsProvided` removed.
            // Generator details flow through the server aggregator
            // now; the AI panel doesn't need a client-side
            // existence check for it.
            convertedReadsLabel,
            annualProductionEstimatesLabel,
          },
          allRatioSummary: performanceRatioSummary,
          compliantRatioSummary: compliantPerformanceRatioSummary,
          // Ship a small sample of rows — top 20 by performance ratio
          // so the model sees representative data without paying for
          // thousands of rows per ask.
          sampleCompliantRows: compliantPerformanceRatioRows
            .slice(0, 20)
            .map((r) => ({
              monitoring: r.monitoring,
              monitoringSystemId: r.monitoringSystemId,
              systemName: r.systemName,
              performanceRatioPercent: r.performanceRatioPercent,
              productionDeltaWh: r.productionDeltaWh,
              expectedProductionWh: r.expectedProductionWh,
              compliantSource: r.compliantSource,
              readDate: r.readDate
                ? new Date(r.readDate).toISOString().slice(0, 10)
                : null,
            })),
        })}
      />
    </div>
  );
});
