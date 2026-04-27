/**
 * Server-side production-trend aggregator for the Trends tab.
 *
 * Task 5.13 PR-4 (2026-04-27) — moves the last two raw-row useMemos
 * out of `client/src/solar-rec-dashboard/components/TrendsTab.tsx`:
 *   - `trendProductionMoM` — month-over-month production deltas for
 *     the top 10 sites by total output (chart data).
 *   - `trendTopSiteIds` — the bare list of those 10 site IDs (legend
 *     order).
 *
 * Both useMemos iterated `convertedReads.rows`, which became
 * row-backed via Task 5.12 PR-10 (#152). With this PR shipped,
 * TrendsTab reads zero `datasets[k].rows` arrays — fully off the
 * raw-row consumption path.
 *
 * The aggregate is cheap to ship (top 10 sites × tens of months ≈
 * a few hundred number cells) so plain JSON cache serde is fine —
 * no Date fields in the output. Cache key bundles the
 * `convertedReads` batch ID; the result has no time-of-day
 * component, so no daily bucket needed (unlike PR-2's
 * `trendDeliveryPace`).
 *
 * The pure aggregator mirrors the client useMemo body byte-for-byte
 * (same `parseFloat` calls, same `new Date()` parsing, same MAX
 * over (site, month), same top-10 sort) so existing TrendsTab
 * behavior is preserved end-to-end.
 */

import { createHash } from "node:crypto";
import { srDsConvertedReads } from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import type { CsvRow } from "./aggregatorHelpers";
import { loadDatasetRows } from "./buildSystemSnapshot";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

// ---------------------------------------------------------------------------
// Output type — structurally identical to what `trendProductionMoM`
// + `trendTopSiteIds` returned client-side. The chart-row shape is
// `{ month: "YYYY-MM", [siteId]: kWhDelta, ... }`.
// ---------------------------------------------------------------------------

/** One chart data point — month label + delta-kWh per site column. */
export type TrendsProductionMoMRow = Record<string, string | number>;

export type TrendsProductionData = {
  chartRows: TrendsProductionMoMRow[];
  /**
   * The 10 site IDs (in legend order) that the chart's columns are
   * keyed on. Derived from the chart-row keys to match the client's
   * `trendTopSiteIds` useMemo exactly: `Object.keys(first).filter(
   * (k) => k !== "month").slice(0, 10)`.
   */
  topSiteIds: string[];
};

const EMPTY_TRENDS_PRODUCTION_DATA: TrendsProductionData = Object.freeze({
  chartRows: [],
  topSiteIds: [],
}) as TrendsProductionData;

// ---------------------------------------------------------------------------
// Pure aggregator — byte-for-byte mirror of the client useMemo body.
// ---------------------------------------------------------------------------

export function buildTrendsProduction(input: {
  convertedReadsRows: CsvRow[];
}): TrendsProductionData {
  const { convertedReadsRows: rows } = input;
  if (rows.length === 0) return EMPTY_TRENDS_PRODUCTION_DATA;

  // Group by site_id + month; keep the MAX lifetime read per (site,
  // month) bucket — lifetime meters monotonically increase, so the
  // last reading in a month is the largest.
  const siteMonths = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const sysId =
      row.monitoring_system_id || row.monitoring_system_name || "";
    if (!sysId) continue;
    const rawWh = parseFloat(row.lifetime_meter_read_wh || "");
    if (!Number.isFinite(rawWh)) continue;
    const readDate = row.read_date || "";
    if (!readDate) continue;
    const d = new Date(readDate);
    if (isNaN(d.getTime())) continue;
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}`;

    if (!siteMonths.has(sysId)) siteMonths.set(sysId, new Map());
    const months = siteMonths.get(sysId)!;
    // NOTE: pre-existing client behavior — the `?? 0` default means
    // a first reading of value 0 is silently dropped (not stored
    // because `0 > 0` is false). Real prod readings are always > 0
    // (cumulative lifetime meters), so the edge case rarely
    // matters. Keeping byte-equivalent for the migration; a
    // follow-up should switch to `existing === undefined ||
    // rawWh > existing` to cover the corner case.
    const existing = months.get(monthKey) ?? 0;
    if (rawWh > existing) months.set(monthKey, rawWh);
  }

  // Convert per-site monthly MAX readings into month-over-month
  // deltas (kWh). Drops any non-positive delta (treat as a meter
  // reset / no-data hole).
  type SiteTrend = {
    siteId: string;
    months: { month: string; deltaKwh: number }[];
  };
  const siteTrends: SiteTrend[] = [];

  siteMonths.forEach((months, siteId) => {
    const sorted = Array.from(months.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    const deltas: { month: string; deltaKwh: number }[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const delta = (sorted[i][1] - sorted[i - 1][1]) / 1000; // Wh → kWh
      if (delta > 0)
        deltas.push({ month: sorted[i][0], deltaKwh: Math.round(delta) });
    }
    if (deltas.length > 0) siteTrends.push({ siteId, months: deltas });
  });

  // Top 10 sites by total production.
  const sortedTop = siteTrends
    .map((s) => ({
      ...s,
      total: s.months.reduce((a, m) => a + m.deltaKwh, 0),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // Build chart data: each row is a month, each column is a site.
  const allMonths = Array.from(
    new Set(siteTrends.flatMap((s) => s.months.map((m) => m.month)))
  ).sort();

  const chartRows: TrendsProductionMoMRow[] = allMonths.map((month) => {
    const point: TrendsProductionMoMRow = { month };
    for (const site of sortedTop) {
      const m = site.months.find((mm) => mm.month === month);
      point[site.siteId] = m?.deltaKwh ?? 0;
    }
    return point;
  });

  // Derive topSiteIds the same way the client does — from the chart
  // rows' keys, not directly from `sortedTop`. Kept this way so the
  // server output is byte-equivalent to what the client used to
  // produce, including the corner case where `chartRows` is empty
  // (empty months list AND no site trends) — in which case
  // `topSiteIds` is empty regardless of how many sites exist.
  const topSiteIds =
    chartRows.length === 0
      ? []
      : Object.keys(chartRows[0])
          .filter((k) => k !== "month")
          .slice(0, 10);

  return { chartRows, topSiteIds };
}

// ---------------------------------------------------------------------------
// Cached server entrypoint.
// ---------------------------------------------------------------------------

const TRENDS_PRODUCTION_DEPS = ["convertedReads"] as const;
const ARTIFACT_TYPE = "trendsProduction";

export const TRENDS_PRODUCTION_RUNNER_VERSION =
  "data-flow-pr5_13_trendsproduction@1";

async function computeTrendsProductionInputHash(scopeId: string): Promise<{
  hash: string;
  convertedReadsBatchId: string | null;
}> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    TRENDS_PRODUCTION_DEPS as unknown as string[]
  );
  const convertedReadsBatchId =
    versions.find((v) => v.datasetKey === "convertedReads")?.batchId ?? null;

  const hash = createHash("sha256")
    .update(`convertedReads:${convertedReadsBatchId ?? ""}`)
    .digest("hex")
    .slice(0, 16);

  return { hash, convertedReadsBatchId };
}

/**
 * Public entrypoint for the tRPC query. Returns the same chart-rows
 * + top-site-ids structure the two TrendsTab useMemos used to
 * produce, plus a `fromCache` flag.
 */
export async function getOrBuildTrendsProduction(
  scopeId: string
): Promise<TrendsProductionData & { fromCache: boolean }> {
  const { hash, convertedReadsBatchId } =
    await computeTrendsProductionInputHash(scopeId);

  if (!convertedReadsBatchId) {
    return { ...EMPTY_TRENDS_PRODUCTION_DATA, fromCache: false };
  }

  const { result, fromCache } = await withArtifactCache<TrendsProductionData>({
    scopeId,
    artifactType: ARTIFACT_TYPE,
    inputVersionHash: hash,
    serde: jsonSerde<TrendsProductionData>(),
    rowCount: (data) => data.chartRows.length,
    recompute: async () => {
      const convertedReadsRows = await loadDatasetRows(
        scopeId,
        convertedReadsBatchId,
        srDsConvertedReads
      );
      return buildTrendsProduction({ convertedReadsRows });
    },
  });

  return { ...result, fromCache };
}
