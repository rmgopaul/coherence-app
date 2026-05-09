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
import { Loader2, Upload } from "lucide-react";
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
import { toast } from "sonner";
import {
  createLogId,
  formatDate,
  formatMonthYear,
  formatNumber,
  formatRelativeTime,
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

/**
 * Phase 2 PR-G-4 (2026-05-07) — retained for compatibility with
 * the existing test fixture in
 * `server/services/solar/buildPerformanceRatioAggregates.test.ts`.
 * Production code now uses `factRowToPerformanceRatioRow` (per-row,
 * inside the page-walk flatten).
 */
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

/**
 * Convert one `decimal(p,s)` string back to `number | null`.
 * Drizzle MySQL `decimal()` columns wire as `string | null`;
 * `PerformanceRatioRow` carries `number | null`. NaN / Infinity
 * resolve to null.
 */
function parsePerfRatioDecimal(
  value: string | number | null
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 2026-05-09 — Option C — wire shape from the new
 * `getDashboardPerformanceRatioPage` proc. `scopeId` and `buildId`
 * are STRIPPED at the wire boundary (not consumed by the client).
 * `createdAt` / `updatedAt` likewise omitted.
 */
type PerformanceRatioFactWireRow = {
  key: string;
  convertedReadKey: string;
  matchType: string;
  monitoring: string;
  monitoringSystemId: string;
  monitoringSystemName: string;
  readDate: string | Date | null;
  readDateRaw: string;
  lifetimeReadWh: string | number | null;
  trackingSystemRefId: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  systemName: string;
  installerName: string;
  monitoringPlatform: string;
  portalAcSizeKw: string | number | null;
  abpAcSizeKw: string | number | null;
  part2VerificationDate: string | Date | null;
  baselineReadWh: string | number | null;
  baselineDate: string | Date | null;
  baselineSource: string | null;
  productionDeltaWh: string | number | null;
  expectedProductionWh: string | number | null;
  performanceRatioPercent: string | number | null;
  contractValue: string | number | null;
};

/**
 * Convert one fact-table row (the wire shape tRPC ships from
 * `getDashboardPerformanceRatioPage`) into the
 * `PerformanceRatioRow` shape the tab's filter / sort / summary
 * memos consume. 8 decimal fields parse from string to number;
 * 3 nullable date fields revive via `reviveNullableDate`.
 *
 * `lifetimeReadWh` and `contractValue` are NOT NULL in the
 * fact-table schema; the runner step drops rows whose values are
 * non-finite. We coerce to 0 here defensively for malformed rows.
 */
function factRowToPerformanceRatioRow(
  row: PerformanceRatioFactWireRow
): PerformanceRatioRow {
  return {
    key: row.key,
    convertedReadKey: row.convertedReadKey,
    matchType: row.matchType as PerformanceRatioMatchType,
    monitoring: row.monitoring,
    monitoringSystemId: row.monitoringSystemId,
    monitoringSystemName: row.monitoringSystemName,
    readDate: reviveNullableDate(row.readDate),
    readDateRaw: row.readDateRaw,
    lifetimeReadWh: parsePerfRatioDecimal(row.lifetimeReadWh) ?? 0,
    trackingSystemRefId: row.trackingSystemRefId,
    systemId: row.systemId,
    stateApplicationRefId: row.stateApplicationRefId,
    systemName: row.systemName,
    installerName: row.installerName,
    monitoringPlatform: row.monitoringPlatform,
    portalAcSizeKw: parsePerfRatioDecimal(row.portalAcSizeKw),
    abpAcSizeKw: parsePerfRatioDecimal(row.abpAcSizeKw),
    part2VerificationDate: reviveNullableDate(row.part2VerificationDate),
    baselineReadWh: parsePerfRatioDecimal(row.baselineReadWh),
    baselineDate: reviveNullableDate(row.baselineDate),
    baselineSource: row.baselineSource,
    productionDeltaWh: parsePerfRatioDecimal(row.productionDeltaWh),
    expectedProductionWh: parsePerfRatioDecimal(row.expectedProductionWh),
    performanceRatioPercent: parsePerfRatioDecimal(
      row.performanceRatioPercent
    ),
    contractValue: parsePerfRatioDecimal(row.contractValue) ?? 0,
  };
}

// 2026-05-09 — Option C — `sortPerformanceRatioRowsForDisplay`
// removed. Sorting now happens server-side via the page proc's
// `sortBy` / `sortDir` args; the visible page rows arrive
// pre-sorted from the server. The pre-cutover function flattened
// every walked page and re-sorted client-side, which only made
// sense when the auto-walk loaded the full row set.

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
  // 2026-05-09 — Option C — server-side filter / sort / paginate.
  //
  // The auto-walk pattern that materialized every fact row on the
  // user's request hot path is GONE. The tab now reads:
  //   - `getDashboardPerformanceRatioSummary` — global summary
  //     with monitoringOptions + portfolio aggregates. Used for
  //     headline tiles when filters are at default; falls back to
  //     `getDashboardPerformanceRatioFilteredAggregates` when any
  //     filter / search is set.
  //   - `getDashboardPerformanceRatioPage` — single-page lazy
  //     read under the current filter / sort / page state.
  //     Only ~50–100 rows ship over the wire per page change.
  //   - `getDashboardPerformanceRatioCompliantContext` — pre-
  //     aggregated auto-compliant Map + best-per-system rows for
  //     the bottom-of-tab compliant section. Built once during
  //     the build runner step; reads are O(1).
  //
  // Visibility is gated on the summary's `buildId`. A failed or
  // in-flight build does NOT corrupt the tab — the prior visible
  // build's rows continue to render until the new build's
  // summary write succeeds (= visibility flip).
  // -------------------------------------------------------------------------
  const performanceRatioPageSize = PERFORMANCE_RATIO_PAGE_SIZE;

  // tRPC utils — used by the rebuild-invalidation useEffect below
  // and by the CSV-export download callback further down.
  const solarRecTrpcUtils = solarRecTrpc.useUtils();

  // 2026-05-09 — Option C — staleTime tightened from 60s to 15s
  // and `refetchOnWindowFocus` enabled so a rebuild triggered from
  // a sibling tab / dashboard header is picked up within ~15s of
  // the summary's visibility flip. The tab also explicitly
  // invalidates the page + filtered-aggregates + compliant-context
  // queries when the summary's `buildId` changes (see
  // `useEffect` below).
  const performanceRatioSummaryQuery =
    solarRecTrpc.solarRecDashboard.getDashboardPerformanceRatioSummary.useQuery(
      undefined,
      { staleTime: 15_000, refetchOnWindowFocus: true },
    );

  // Filter args used by both the page query and the filtered-
  // aggregates query — share the same shape so query keys stay in
  // lockstep and an aggregate refetch matches what's on screen.
  const trimmedSearch = deferredPerformanceRatioSearch.trim();
  const performanceRatioFilterArgs = useMemo(
    () => ({
      matchType:
        performanceRatioMatchFilter === "All"
          ? null
          : performanceRatioMatchFilter,
      monitoring:
        performanceRatioMonitoringFilter === "All"
          ? null
          : performanceRatioMonitoringFilter,
      search: trimmedSearch.length > 0 ? trimmedSearch : null,
    }),
    [
      performanceRatioMatchFilter,
      performanceRatioMonitoringFilter,
      trimmedSearch,
    ],
  );

  const performanceRatioOffset =
    Math.max(0, performanceRatioPage - 1) * performanceRatioPageSize;

  const performanceRatioPageQuery =
    solarRecTrpc.solarRecDashboard.getDashboardPerformanceRatioPage.useQuery(
      {
        offset: performanceRatioOffset,
        limit: performanceRatioPageSize,
        matchType: performanceRatioFilterArgs.matchType,
        monitoring: performanceRatioFilterArgs.monitoring,
        search: performanceRatioFilterArgs.search,
        sortBy: performanceRatioSortBy,
        sortDir: performanceRatioSortDir,
      },
      {
        staleTime: 60_000,
        // Keep the previous page's rows on screen while the new
        // page is in flight — avoids a flash of empty content
        // when the user clicks Next. Mirror tRPC v11's
        // `placeholderData: keepPreviousData` pattern.
        placeholderData: (prev) => prev,
      },
    );

  // Filtered aggregates: only fired when the user has applied a
  // filter / search that differs from the global summary's
  // baseline. When at default, the summary's totals already
  // reflect "everything" and we save the round-trip.
  const performanceRatioFiltersAreDefault =
    performanceRatioFilterArgs.matchType === null &&
    performanceRatioFilterArgs.monitoring === null &&
    performanceRatioFilterArgs.search === null;
  const performanceRatioFilteredAggregatesQuery =
    solarRecTrpc.solarRecDashboard.getDashboardPerformanceRatioFilteredAggregates.useQuery(
      performanceRatioFilterArgs,
      {
        staleTime: 60_000,
        enabled: !performanceRatioFiltersAreDefault,
      },
    );

  // Compliant context — fired only when the Snapshot Log /
  // compliant section is in view. (The tab renders all sections
  // at once today; the query fires unconditionally. A future
  // optimization could gate by section-in-viewport.)
  //
  // 2026-05-09 — PR-CB-5 — this proc still serves the auto-
  // compliant sources Map (the upper "Compliant Sources" table).
  // The `bestPerSystem` field on the response is no longer read;
  // PR-CB-6 will drop it from the proc + retire the artifact
  // write path. The compliant report table below now reads from
  // `getDashboardPerformanceRatioCompliantBestPage` (paginated)
  // and `getDashboardPerformanceRatioCompliantBestSummary` (slim
  // aggregates) — all 21k+ rows visible without truncation.
  const performanceRatioCompliantContextQuery =
    solarRecTrpc.solarRecDashboard.getDashboardPerformanceRatioCompliantContext.useQuery(
      undefined,
      { staleTime: 60_000 },
    );

  // 2026-05-09 — PR-CB-5 — slim summary for the compliant-best
  // section: server-side `count` + `withCompliantSource`. The
  // tile's third value (`withEvidence`) stays client-derived
  // because evidence is per-systemId localStorage state.
  const compliantBestSummaryQuery =
    solarRecTrpc.solarRecDashboard.getDashboardPerformanceRatioCompliantBestSummary.useQuery(
      undefined,
      { staleTime: 60_000 },
    );

  // 2026-05-09 — PR-CB-5 — paginated read of the compliant-best
  // rows. Server-side pagination at COMPLIANT_REPORT_PAGE_SIZE
  // rows/page, gated on the summary artifact's buildId. No
  // truncation cap; works for any portfolio size.
  const compliantBestPageOffset =
    Math.max(0, compliantReportPage - 1) * COMPLIANT_REPORT_PAGE_SIZE;
  const compliantBestPageQuery =
    solarRecTrpc.solarRecDashboard.getDashboardPerformanceRatioCompliantBestPage.useQuery(
      {
        offset: compliantBestPageOffset,
        limit: COMPLIANT_REPORT_PAGE_SIZE,
        // No filter / sort UI yet — passing defaults
        // (`readDate DESC`, tie-break on PK `systemKey ASC`).
        //
        // 2026-05-09 self-review fixup: this is NOT identical to
        // the historical artifact-backed ordering, which was
        // `(read-window-month DESC, ratio DESC, systemName ASC)`
        // — a compound sort that bucketed reads by month, then
        // ranked by ratio within each bucket. The new default is
        // simpler (per-row readDate, no month-bucketing) and the
        // tie-break differs (systemKey vs systemName + ratio).
        // Acceptable trade for the migration: same first-page rows
        // for typical usage (one read per system per month means
        // readDate and read-window-month coincide), but on
        // multi-read months the row order can shift visibly. A
        // future PR can extend the proc + add a `displayOrder`
        // sort enum that emits the legacy compound ordering;
        // skipped here to keep CB-5 scoped to the read-path
        // cutover.
        compliantSource: null,
        monitoring: null,
        search: null,
        sortBy: "readDate",
        sortDir: "desc",
      },
      {
        staleTime: 60_000,
        // Keep the previous page on screen while the next page is
        // in flight — avoids a flash of empty content. Mirrors
        // the parent perf-ratio page proc's `placeholderData`.
        placeholderData: (prev) => prev,
      },
    );

  // Reset to first page on any filter / sort / search change.
  // Under Option C the filter args are part of the page query's
  // key, so a filter change refetches page 1 without touching
  // local state. We still reset `performanceRatioPage` to 1
  // because the user may have navigated to page 5 of the prior
  // filter.
  //
  // Depend on `deferredPerformanceRatioSearch` (NOT the immediate
  // `performanceRatioSearch`) so the reset happens when the page
  // query's actual filter args change — pre-fix this used the
  // immediate value, which fired the reset on every keystroke
  // even though the page query itself only refetched after the
  // deferred value updated.
  useEffect(() => {
    setPerformanceRatioPage(1);
  }, [
    performanceRatioMonitoringFilter,
    performanceRatioMatchFilter,
    performanceRatioSortBy,
    performanceRatioSortDir,
    deferredPerformanceRatioSearch,
  ]);

  // Pending = the FIRST visible state hasn't landed yet (summary +
  // page 1). Subsequent paginations don't gate the tab.
  const performanceRatioFirstPagePending =
    performanceRatioPageQuery.status === "pending";
  const performanceRatioIsBuilding =
    performanceRatioSummaryQuery.data?.available === false ||
    performanceRatioPageQuery.data?.available === false;
  const performanceRatioQueryIsPending =
    performanceRatioFirstPagePending ||
    performanceRatioSummaryQuery.isPending;
  const performanceRatioQueryError =
    performanceRatioSummaryQuery.error ?? performanceRatioPageQuery.error;

  // Cache-miss elapsed-time tracker. Surfaces only while the
  // first page is loading or the summary hasn't landed yet — once
  // either is available the tile grid renders real values.
  const performanceRatioStartedAtRef = useRef<number | null>(null);
  const [performanceRatioElapsedSec, setPerformanceRatioElapsedSec] =
    useState(0);
  useEffect(() => {
    if (!performanceRatioQueryIsPending) {
      performanceRatioStartedAtRef.current = null;
      setPerformanceRatioElapsedSec(0);
      return;
    }
    if (performanceRatioStartedAtRef.current === null) {
      performanceRatioStartedAtRef.current = Date.now();
    }
    const interval = window.setInterval(() => {
      const startedAt = performanceRatioStartedAtRef.current;
      if (startedAt !== null) {
        setPerformanceRatioElapsedSec(
          Math.round((Date.now() - startedAt) / 1000),
        );
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [performanceRatioQueryIsPending]);

  // 2026-05-09 — Option C — query invalidation on rebuild. When
  // the summary's `buildId` changes (a new build's visibility
  // flip), invalidate the dependent queries so the page +
  // filtered-aggregates + compliant-context refetch under the new
  // build immediately rather than waiting for staleTime.
  const lastObservedBuildIdRef = useRef<string | null>(null);
  useEffect(() => {
    const summary = performanceRatioSummaryQuery.data;
    if (!summary || summary.available === false) return;
    const newBuildId = summary.buildId;
    if (lastObservedBuildIdRef.current === newBuildId) return;
    const previous = lastObservedBuildIdRef.current;
    lastObservedBuildIdRef.current = newBuildId;
    if (previous !== null) {
      // First-paint case (previous === null): no need to
      // invalidate — the queries haven't fetched yet.
      void Promise.all([
        solarRecTrpcUtils.solarRecDashboard.getDashboardPerformanceRatioPage.invalidate(),
        solarRecTrpcUtils.solarRecDashboard.getDashboardPerformanceRatioFilteredAggregates.invalidate(),
        solarRecTrpcUtils.solarRecDashboard.getDashboardPerformanceRatioCompliantContext.invalidate(),
        // 2026-05-09 — PR-CB-5 — also invalidate the new
        // compliant-best summary + page queries so the rebuild
        // surfaces in the compliant report table within seconds.
        solarRecTrpcUtils.solarRecDashboard.getDashboardPerformanceRatioCompliantBestSummary.invalidate(),
        solarRecTrpcUtils.solarRecDashboard.getDashboardPerformanceRatioCompliantBestPage.invalidate(),
      ]).catch((err) => {
        // TanStack `invalidate` rejecting is rare (network blip
        // mid-mutation, etc.). Log so the user-facing "data is
        // stale post-rebuild" never goes silent.
        console.warn(
          "[performance-ratio-tab] post-rebuild query invalidation failed:",
          err,
        );
      });
    }
  }, [performanceRatioSummaryQuery.data, solarRecTrpcUtils]);

  // Convert the visible page's wire rows into the shape the rest
  // of the tab consumes (revived dates + numeric decimals).
  const visiblePerformanceRatioRows = useMemo<PerformanceRatioRow[]>(() => {
    const data = performanceRatioPageQuery.data;
    if (!data || data.available === false) return [];
    const wireRows = data.rows as unknown as PerformanceRatioFactWireRow[];
    return wireRows.map(factRowToPerformanceRatioRow);
  }, [performanceRatioPageQuery.data]);

  // Total filtered count — drives the page navigation footer.
  const performanceRatioFilteredCount = useMemo(() => {
    const data = performanceRatioPageQuery.data;
    if (!data || data.available === false) return 0;
    return data.totalCount;
  }, [performanceRatioPageQuery.data]);

  // Compatibility shim: the rest of the tab reads
  // `performanceRatioQuery.{isPending, isError, error,
  // isLoadingMore, isBuilding}` to render the loading + error
  // UX. Map the new queries onto that shape so the JSX render
  // path stays unchanged.
  const performanceRatioQuery = useMemo(
    () => ({
      isPending: performanceRatioQueryIsPending,
      isError: Boolean(performanceRatioQueryError),
      error: performanceRatioQueryError,
      isLoadingMore: performanceRatioPageQuery.isFetching,
      isBuilding: Boolean(performanceRatioIsBuilding),
    }),
    [
      performanceRatioQueryIsPending,
      performanceRatioQueryError,
      performanceRatioPageQuery.isFetching,
      performanceRatioIsBuilding,
    ],
  );

  // -------------------------------------------------------------------------
  // 2026-05-09 — Option C — filter dropdown options + headline tile values.
  //
  // `performanceRatioMonitoringOptions` reads from the summary's
  // `monitoringOptions` array (built once during the build runner step).
  // `performanceRatioSummary` reads from the summary when filters are
  // at default (cheaper, no extra round-trip), and from the filtered-
  // aggregates query when filters are set.
  // -------------------------------------------------------------------------
  const performanceRatioMonitoringOptions = useMemo(() => {
    const summary = performanceRatioSummaryQuery.data;
    if (!summary || summary.available === false) return [];
    return summary.monitoringOptions ?? [];
  }, [performanceRatioSummaryQuery.data]);

  const performanceRatioTotalPages = Math.max(
    1,
    Math.ceil(performanceRatioFilteredCount / performanceRatioPageSize),
  );
  const performanceRatioCurrentPage = Math.min(
    performanceRatioPage,
    performanceRatioTotalPages,
  );

  // Clamp page state if the user shrank the result set so the new
  // total pages is below the current page.
  useEffect(() => {
    if (performanceRatioPage <= performanceRatioTotalPages) return;
    setPerformanceRatioPage(performanceRatioTotalPages);
  }, [performanceRatioPage, performanceRatioTotalPages]);

  const performanceRatioSummary = useMemo(() => {
    const summary = performanceRatioSummaryQuery.data;
    const filtered = performanceRatioFilteredAggregatesQuery.data;

    // Converted-read counts always come from the global summary.
    const convertedReadCount =
      summary?.available === true ? summary.convertedReadCount : 0;
    const matchedConvertedReads =
      summary?.available === true ? summary.matchedConvertedReads : 0;
    const unmatchedConvertedReads =
      summary?.available === true ? summary.unmatchedConvertedReads : 0;
    const invalidConvertedReads =
      summary?.available === true ? summary.invalidConvertedReads : 0;

    // Aggregates: filtered when filters set, global summary otherwise.
    const sourceAggregates =
      !performanceRatioFiltersAreDefault &&
      filtered?.available === true
        ? filtered
        : summary?.available === true
          ? summary
          : null;

    if (!sourceAggregates) {
      return {
        convertedReadCount,
        matchedConvertedReads,
        unmatchedConvertedReads,
        invalidConvertedReads,
        allocationCount: 0,
        withBaseline: 0,
        withExpected: 0,
        withRatio: 0,
        totalDeltaWh: 0,
        totalExpectedWh: 0,
        portfolioRatioPercent: null as number | null,
        totalContractValue: 0,
      };
    }
    return {
      convertedReadCount,
      matchedConvertedReads,
      unmatchedConvertedReads,
      invalidConvertedReads,
      allocationCount: sourceAggregates.allocationCount,
      withBaseline: sourceAggregates.withBaseline,
      withExpected: sourceAggregates.withExpected,
      withRatio: sourceAggregates.withRatio,
      totalDeltaWh: sourceAggregates.totalDeltaWh,
      totalExpectedWh: sourceAggregates.totalExpectedWh,
      portfolioRatioPercent: sourceAggregates.portfolioRatioPercent,
      totalContractValue: sourceAggregates.totalContractValue,
    };
  }, [
    performanceRatioSummaryQuery.data,
    performanceRatioFilteredAggregatesQuery.data,
    performanceRatioFiltersAreDefault,
  ]);

  // 2026-05-09 — "Last rebuilt" timestamp surface. The summary
  // proc returns `builtAt` (ISO 8601, set by the build runner when
  // it writes the side-cache row) on every available payload. The
  // tab tiles read filtered or global aggregates depending on
  // filters, but `builtAt` is always sourced from the unfiltered
  // summary — a filter change does NOT trigger a rebuild, only a
  // re-aggregation of the existing facts. Showing the build time
  // alongside the tiles makes "are these numbers fresh?" answerable
  // without a debug proc.
  const performanceRatioBuiltAtDisplay = useMemo(() => {
    const summary = performanceRatioSummaryQuery.data;
    if (!summary || summary.available !== true) return null;
    const builtAtMs = Date.parse(summary.builtAt);
    if (!Number.isFinite(builtAtMs)) return null;
    const relative = formatRelativeTime(builtAtMs);
    if (!relative) return null;
    // Absolute time uses the user's locale, with date-and-time
    // granularity. `month: "short"` keeps it short ("May 9, 2026,
    // 1:30 PM") so the row stays one line on narrow viewports.
    const absolute = new Date(builtAtMs).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return { relative, absolute };
  }, [performanceRatioSummaryQuery.data]);

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

  // 2026-05-09 — Option C — read pre-aggregated auto-compliant
  // map from the build runner's side cache. Pre-cutover this
  // memo iterated every fact row client-side to derive the same
  // map; under Option C the client never sees the full row set.
  const autoCompliantSourceByPortalId = useMemo(() => {
    const data = performanceRatioCompliantContextQuery.data;
    if (!data || data.available === false) {
      return new Map<string, string>();
    }
    const mapping = new Map<string, string>();
    for (const [systemId, source] of Object.entries(data.autoSources)) {
      mapping.set(systemId, source);
    }
    return mapping;
  }, [performanceRatioCompliantContextQuery.data]);

  // 2026-05-09 — PR-CB-5 — auto-sources truncation flag (read
  // from the legacy compliant-context proc that still holds the
  // 25k-cap autoSources Map). The bestPerSystem truncation flag
  // is gone because the new paginated reader has no cap — all
  // 21k+ rows are visible via the report table's pagination.
  const performanceRatioCompliantTruncation = useMemo(() => {
    const data = performanceRatioCompliantContextQuery.data;
    if (!data || data.available === false) {
      return {
        autoSourcesTruncated: false,
        autoSourcesTotalEntries: 0,
      };
    }
    return {
      autoSourcesTruncated: data.autoSourcesTruncated,
      autoSourcesTotalEntries: data.autoSourcesTotalEntries,
    };
  }, [performanceRatioCompliantContextQuery.data]);

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

  // 2026-05-09 — PR-CB-5 — server-paginated compliant-best rows.
  // The proc already applied the eligibility filter (part2 +
  // ratio in [30, 150]), grouped by systemKey, reduced to "best
  // per system", and pre-attached `compliantSource` from the
  // auto-compliant Map. The client just revives date strings,
  // overlays manual `compliantSource` from localStorage, and
  // adds the month-year format fields the JSX consumes. The
  // refactor swaps the source from the artifact JSON's
  // `bestPerSystem` array (capped at 5k) to the new paginated
  // proc that reads from
  // `solarRecDashboardPerformanceRatioCompliantFacts` (no cap).
  const visibleCompliantPerformanceRows = useMemo<
    CompliantPerformanceRatioRow[]
  >(() => {
    const data = compliantBestPageQuery.data;
    if (!data || data.available === false) return [];
    return data.rows.map((row) => {
      const readDate = reviveNullableDate(row.readDate);
      const baselineDate = reviveNullableDate(row.baselineDate);
      const part2VerificationDate = reviveNullableDate(
        row.part2VerificationDate,
      );
      const compliantEntry = row.systemId
        ? compliantSourceByPortalId.get(row.systemId)
        : undefined;
      return {
        key: row.key,
        // The wire shape doesn't carry `convertedReadKey`; the
        // CompliantPerformanceRatioRow parent type still declares
        // it but no JSX consumer reads it today. Pass through
        // `key` for forward compatibility.
        convertedReadKey: row.key,
        // Cast is sound — the build runner only emits one of the
        // 3 enum values; runtime mismatch would mean schema drift
        // the user can't introduce client-side.
        matchType: row.matchType as PerformanceRatioMatchType,
        monitoring: row.monitoring,
        monitoringSystemId: row.monitoringSystemId,
        monitoringSystemName: row.monitoringSystemName,
        monitoringPlatform: row.monitoringPlatform,
        installerName: row.installerName,
        readDate,
        readDateRaw: row.readDateRaw,
        // Decimal columns ship as `string | null` from Drizzle's
        // MySQL adapter (precision-preserving). Revive to numbers
        // for the client-side display + comparisons. The
        // PerformanceRatioCompliantBestRow type expects
        // `number | null` for nullable columns and `number` for
        // NOT NULL columns. NOT NULL fields use `?? 0` as a
        // belt-and-braces fallback if the wire value is malformed
        // (mirrors the parent fact-row reviver `factRowToPerformanceRatioRow`).
        lifetimeReadWh: parsePerfRatioDecimal(row.lifetimeReadWh) ?? 0,
        trackingSystemRefId: row.trackingSystemRefId,
        systemId: row.systemId,
        stateApplicationRefId: row.stateApplicationRefId,
        systemName: row.systemName,
        portalAcSizeKw: parsePerfRatioDecimal(row.portalAcSizeKw),
        abpAcSizeKw: parsePerfRatioDecimal(row.abpAcSizeKw),
        part2VerificationDate,
        baselineReadWh: parsePerfRatioDecimal(row.baselineReadWh),
        baselineDate,
        baselineSource: row.baselineSource,
        productionDeltaWh: parsePerfRatioDecimal(row.productionDeltaWh),
        expectedProductionWh: parsePerfRatioDecimal(row.expectedProductionWh),
        performanceRatioPercent: parsePerfRatioDecimal(
          row.performanceRatioPercent,
        ),
        contractValue: parsePerfRatioDecimal(row.contractValue) ?? 0,
        // Manual overlay wins over the build runner's auto source.
        compliantSource:
          compliantEntry?.compliantSource ?? row.compliantSource ?? null,
        evidenceCount: compliantEntry?.evidence.length ?? 0,
        meterReadMonthYear: formatMonthYear(readDate),
        readWindowMonthYear: readDate
          ? formatMonthYear(toReadWindowMonthStart(readDate))
          : "N/A",
      } satisfies CompliantPerformanceRatioRow;
    });
  }, [compliantBestPageQuery.data, compliantSourceByPortalId]);

  // 2026-05-09 — PR-CB-5 — server-side aggregates from the slim
  // summary proc. `withEvidence` stays client-derived because
  // evidence is per-systemId localStorage state — count of
  // manually-tagged systems with at least one evidence file.
  // Slight semantic drift from pre-CB-5: was "count of compliant
  // rows whose systemId has evidence" (intersection); now is
  // "count of evidenced systemIds" (single-source). For typical
  // usage these are nearly identical because manual tags are
  // applied to systems already in the compliant set.
  const compliantPerformanceRatioSummary = useMemo(() => {
    const data = compliantBestSummaryQuery.data;
    const count = data?.available === true ? data.count : 0;
    const withCompliantSource =
      data?.available === true ? data.withCompliantSource : 0;
    const withEvidence = compliantSourceEntries.filter(
      (entry) => entry.evidence.length > 0,
    ).length;
    return { count, withCompliantSource, withEvidence };
  }, [compliantBestSummaryQuery.data, compliantSourceEntries]);

  // Server-driven pagination footer. `totalCount` from the page
  // proc is the canonical value (matches the summary proc's
  // `count`); we read whichever lands first.
  const compliantBestTotalCount = useMemo(() => {
    const pageData = compliantBestPageQuery.data;
    if (pageData?.available === true) return pageData.totalCount;
    return compliantPerformanceRatioSummary.count;
  }, [
    compliantBestPageQuery.data,
    compliantPerformanceRatioSummary.count,
  ]);
  const compliantReportTotalPages = Math.max(
    1,
    Math.ceil(compliantBestTotalCount / COMPLIANT_REPORT_PAGE_SIZE),
  );
  const compliantReportCurrentPage = Math.min(
    compliantReportPage,
    compliantReportTotalPages,
  );
  const compliantReportPageStartIndex =
    (compliantReportCurrentPage - 1) * COMPLIANT_REPORT_PAGE_SIZE;
  const compliantReportPageEndIndex =
    compliantReportPageStartIndex + COMPLIANT_REPORT_PAGE_SIZE;

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
  // 2026-05-09 — Option C — server-side export of the
  // currently-filtered/sorted view. The browser no longer holds
  // the full row set, so the export runs as a background job
  // (`performanceRatioCsv` exportType, accepts the same filter +
  // sort args as the page proc). Polls the job status until
  // terminal, then triggers the artifact download.
  const startDashboardCsvExport =
    solarRecTrpc.solarRecDashboard.startDashboardCsvExport.useMutation();

  const downloadPerformanceRatioCsv = useCallback(async () => {
    const toastId = toast.loading("Preparing performance-ratio CSV…");
    let jobId: string;
    try {
      const startResult = await startDashboardCsvExport.mutateAsync({
        exportType: "performanceRatioCsv",
        matchType: performanceRatioFilterArgs.matchType,
        monitoring: performanceRatioFilterArgs.monitoring,
        search: performanceRatioFilterArgs.search,
        sortBy: performanceRatioSortBy,
        sortDir: performanceRatioSortDir,
      });
      jobId = startResult.jobId;
    } catch (error) {
      console.error("[performance-ratio-csv] start failed:", error);
      toast.error("Could not start performance-ratio CSV export.", {
        id: toastId,
      });
      return;
    }

    // Aligned with the server's `JOB_TTL_MS` (30 min). Per-tick
    // delay grows from 1.5s → 5s → 15s as elapsed time passes.
    const POLL_MAX_MS = 30 * 60 * 1000;
    const startedAt = Date.now();
    function nextPollDelayMs(elapsedMs: number): number {
      if (elapsedMs < 30_000) return 1500;
      if (elapsedMs < 5 * 60_000) return 5000;
      return 15_000;
    }

    let hintShown = false;
    while (Date.now() - startedAt < POLL_MAX_MS) {
      let status: Awaited<
        ReturnType<
          typeof solarRecTrpcUtils.solarRecDashboard.getDashboardCsvExportJobStatus.fetch
        >
      >;
      try {
        status =
          await solarRecTrpcUtils.solarRecDashboard.getDashboardCsvExportJobStatus.fetch(
            { jobId },
          );
      } catch (pollError) {
        console.warn(
          "[performance-ratio-csv] status poll failed (will retry):",
          pollError,
        );
        await new Promise((r) =>
          setTimeout(r, nextPollDelayMs(Date.now() - startedAt)),
        );
        continue;
      }
      if (status.status === "succeeded" && status.url) {
        toast.success(
          `Performance-ratio CSV ready (${formatNumber(
            status.rowCount ?? 0,
          )} rows).`,
          { id: toastId },
        );
        const link = document.createElement("a");
        link.href = status.url;
        link.download = status.fileName ?? "performance-ratio.csv";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return;
      }
      if (status.status === "failed") {
        toast.error(
          status.error ?? "Performance-ratio CSV export failed.",
          { id: toastId },
        );
        return;
      }
      if (status.status === "notFound") {
        toast.error("Performance-ratio CSV job expired.", { id: toastId });
        return;
      }
      if (!hintShown && Date.now() - startedAt >= 30_000) {
        toast.loading("Still preparing performance-ratio CSV…", {
          id: toastId,
        });
        hintShown = true;
      }
      await new Promise((r) =>
        setTimeout(r, nextPollDelayMs(Date.now() - startedAt)),
      );
    }
    toast.error("Performance-ratio CSV export timed out.", { id: toastId });
  }, [
    performanceRatioFilterArgs.matchType,
    performanceRatioFilterArgs.monitoring,
    performanceRatioFilterArgs.search,
    performanceRatioSortBy,
    performanceRatioSortDir,
    startDashboardCsvExport,
    solarRecTrpcUtils,
  ]);

  // 2026-05-09 — PR-CB-5 — compliant report CSV via the
  // background-job pattern. Replaces the in-memory client-side
  // CSV build (which was capped at the artifact's 5k rows). The
  // worker streams from
  // `solarRecDashboardPerformanceRatioCompliantFacts` and writes
  // a temp file → storage; the full 21k+ row dump never crosses
  // tRPC. Manual `compliantSource` overlay from localStorage is
  // NOT applied to this CSV (the worker only sees the auto-
  // resolved sources from the build runner); users who need
  // manual overrides in the export can apply them after import
  // in their downstream tooling.
  //
  // Self-review fixup: when manual entries exist, surface a
  // one-shot warning toast BEFORE dispatching so the user knows
  // their localStorage-only overrides won't be in the file.
  // Pre-fix the loss was silent.
  const manualOverrideCount = useMemo(
    () =>
      compliantSourceEntries.filter(
        (entry) => !!entry.compliantSource || entry.evidence.length > 0,
      ).length,
    [compliantSourceEntries],
  );
  const downloadCompliantPerformanceRatioCsv = useCallback(async () => {
    if (manualOverrideCount > 0) {
      toast.warning(
        `CSV will reflect server-resolved compliant sources only. ${formatNumber(manualOverrideCount)} ${manualOverrideCount === 1 ? "system has" : "systems have"} manual overrides or evidence in localStorage that won't appear in the file.`,
        { duration: 6000 },
      );
    }
    const toastId = toast.loading("Preparing compliant report CSV…");
    let jobId: string;
    try {
      const startResult = await startDashboardCsvExport.mutateAsync({
        exportType: "performanceRatioCompliantBestCsv",
        // Pass the same default filter / sort args the in-tab
        // page query uses so the CSV mirrors what the user sees.
        // A future PR adding filter dropdowns to the compliant
        // section threads them here too.
        compliantSource: null,
        monitoring: null,
        search: null,
        sortBy: "readDate",
        sortDir: "desc",
      });
      jobId = startResult.jobId;
    } catch (error) {
      console.error("[compliant-best-csv] start failed:", error);
      toast.error("Could not start compliant report CSV export.", {
        id: toastId,
      });
      return;
    }

    // Same poll cadence + TTL as the parent perf-ratio CSV
    // download (`downloadPerformanceRatioCsv`). Aligned with the
    // server's `JOB_TTL_MS` (30 min). Per-tick delay grows
    // 1.5s → 5s → 15s as elapsed time passes.
    const POLL_MAX_MS = 30 * 60 * 1000;
    const startedAt = Date.now();
    function nextPollDelayMs(elapsedMs: number): number {
      if (elapsedMs < 30_000) return 1500;
      if (elapsedMs < 5 * 60_000) return 5000;
      return 15_000;
    }

    let hintShown = false;
    while (Date.now() - startedAt < POLL_MAX_MS) {
      let status: Awaited<
        ReturnType<
          typeof solarRecTrpcUtils.solarRecDashboard.getDashboardCsvExportJobStatus.fetch
        >
      >;
      try {
        status =
          await solarRecTrpcUtils.solarRecDashboard.getDashboardCsvExportJobStatus.fetch(
            { jobId },
          );
      } catch (pollError) {
        console.warn(
          "[compliant-best-csv] status poll failed (will retry):",
          pollError,
        );
        await new Promise((r) =>
          setTimeout(r, nextPollDelayMs(Date.now() - startedAt)),
        );
        continue;
      }
      if (status.status === "succeeded" && status.url) {
        toast.success(
          `Compliant report CSV ready (${formatNumber(
            status.rowCount ?? 0,
          )} rows).`,
          { id: toastId },
        );
        const link = document.createElement("a");
        link.href = status.url;
        link.download = status.fileName ?? "performance-ratio-compliant.csv";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return;
      }
      if (status.status === "failed") {
        toast.error(
          status.error ?? "Compliant report CSV export failed.",
          { id: toastId },
        );
        return;
      }
      if (status.status === "notFound") {
        toast.error("Compliant report CSV job expired.", { id: toastId });
        return;
      }
      if (!hintShown && Date.now() - startedAt >= 30_000) {
        toast.loading("Still preparing compliant report CSV…", {
          id: toastId,
        });
        hintShown = true;
      }
      await new Promise((r) =>
        setTimeout(r, nextPollDelayMs(Date.now() - startedAt)),
      );
    }
    toast.error("Compliant report CSV export timed out.", { id: toastId });
  }, [
    startDashboardCsvExport,
    solarRecTrpcUtils,
    manualOverrideCount,
  ]);

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
          {performanceRatioQuery.isBuilding && (
            <Card className="border-amber-200 bg-amber-50/60">
              <CardHeader>
                <CardTitle className="text-base text-amber-900">
                  Performance ratio facts not yet built for this scope
                </CardTitle>
                <CardDescription className="text-amber-800">
                  The Performance Ratio tab now reads from a pre-built fact
                  table populated by the dashboard build runner. No build
                  has populated the table for this scope yet — trigger a
                  rebuild from the dashboard header (or another tab's
                  rebuild button) to populate it. Once a build succeeds
                  this tab loads in under a second.
                </CardDescription>
              </CardHeader>
            </Card>
          )}
          {performanceRatioQuery.isPending &&
            !performanceRatioQuery.isBuilding && (
              <Card className="border-sky-200 bg-sky-50/60">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2 text-sky-900">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading performance ratio…
                    {performanceRatioElapsedSec > 0 && (
                      <span className="text-sm font-normal text-sky-700">
                        ({performanceRatioElapsedSec}s)
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription className="text-sky-800">
                    Reading the pre-built fact table page-by-page. First
                    page typically lands in &lt; 1s; remaining pages stream
                    in incrementally.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}
          {performanceRatioQuery.isLoadingMore &&
            !performanceRatioQuery.isPending &&
            !performanceRatioQuery.isBuilding && (
              <Card className="border-sky-100 bg-sky-50/30">
                <CardHeader className="py-3">
                  <CardTitle className="text-sm flex items-center gap-2 text-sky-900">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading additional rows…
                  </CardTitle>
                  <CardDescription className="text-sky-800 text-xs">
                    Tile values + page 1 are already accurate; deeper
                    rows are still streaming in the background.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}
          {performanceRatioQuery.isError && (
            <Card className="border-rose-200 bg-rose-50/60">
              <CardHeader>
                <CardTitle className="text-base text-rose-900">
                  Performance ratio failed to load
                </CardTitle>
                <CardDescription className="text-rose-800">
                  {performanceRatioQuery.error instanceof Error
                    ? performanceRatioQuery.error.message
                    : "Unknown error. Try refreshing the page."}
                </CardDescription>
              </CardHeader>
            </Card>
          )}
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

          {performanceRatioBuiltAtDisplay ? (
            <p
              className="text-xs text-slate-500"
              data-testid="performance-ratio-built-at"
              title={`Aggregates last rebuilt at ${performanceRatioBuiltAtDisplay.absolute}`}
            >
              Last rebuilt {performanceRatioBuiltAtDisplay.relative}
              <span className="ml-1 text-slate-400">
                ({performanceRatioBuiltAtDisplay.absolute})
              </span>
            </p>
          ) : null}

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
                    {performanceRatioFilteredCount === 0
                      ? "0"
                      : formatNumber(performanceRatioOffset + 1)}
                    -
                    {formatNumber(
                      Math.min(
                        performanceRatioOffset +
                          visiblePerformanceRatioRows.length,
                        performanceRatioFilteredCount,
                      ),
                    )}{" "}
                    of {formatNumber(performanceRatioFilteredCount)}.
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
              {performanceRatioCompliantTruncation.autoSourcesTruncated && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  <p className="font-medium">
                    Auto-compliant sources truncated by the build runner.
                  </p>
                  <p className="mt-1 text-xs">
                    Auto-compliant sources:{" "}
                    {formatNumber(
                      performanceRatioCompliantTruncation.autoSourcesTotalEntries,
                    )}{" "}
                    observed,{" "}
                    {formatNumber(autoCompliantSourceByPortalId.size)} in
                    cache (25,000 cap). The compliant-report table + CSV
                    below cover ALL systems via paginated reads — only the
                    auto-source classification (top table) is affected by
                    this cap.
                  </p>
                </div>
              )}
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
                  {compliantBestTotalCount === 0
                    ? "0"
                    : formatNumber(compliantReportPageStartIndex + 1)}
                  -
                  {formatNumber(
                    Math.min(
                      compliantReportPageEndIndex,
                      compliantBestTotalCount,
                    ),
                  )}{" "}
                  of {formatNumber(compliantBestTotalCount)}.
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
                  {compliantBestTotalCount === 0 ? (
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
          // 2026-05-09 — PR-CB-5 — sample is the currently-visible
          // page (≤10 rows) instead of the legacy `slice(0, 20)`
          // over the full client-side set. Server-paginated reads
          // mean the client never holds the full row set; the
          // visible page is representative of what the user sees
          // on screen, which is what the model should reason about.
          // If a future ask needs more rows for the AI prompt,
          // wire a separate larger-page fetch with its own staleTime.
          sampleCompliantRows: visibleCompliantPerformanceRows.map((r) => ({
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
