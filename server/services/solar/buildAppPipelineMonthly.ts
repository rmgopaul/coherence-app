/**
 * Server-side Application Pipeline monthly aggregator.
 *
 * Task 5.13 PR-5 (2026-04-27) — moves
 * `client/src/solar-rec-dashboard/components/AppPipelineTab.tsx ::
 * pipelineMonthlyRows` onto the server. Three independent pipelines
 * roll up into the same monthly bucket map:
 *
 *   - **Part 1 count + AC kW** — from `abpReport.rows`, deduped by
 *     `resolvePart2ProjectIdentity` and bucketed by
 *     Part_1_submission_date.
 *   - **Part 2 count + AC kW** — same `abpReport.rows`, bucketed by
 *     Part_2_App_Verification_Date with the Excel-serial / calendar
 *     date split logic.
 *   - **Interconnected count + AC kW** — from `generatorDetails.rows`,
 *     deduped by GATS Unit ID and bucketed by Date Online (with
 *     mid-month parse fallback) or Project Online Date Part 2.
 *
 * The AC-kW fallback for interconnected rows reads
 * `system.installedKwAc` from the cached system snapshot — captured
 * server-side via the `extractSnapshotSystems` runtime validator.
 *
 * Output rows include prior-year comparison fields (`prevPart1Count`,
 * etc.) computed from the same buckets — the chart needs them for
 * year-over-year overlay bars.
 *
 * Cache strategy: hash bundles `abpReport` batch + `generatorDetails`
 * batch + system-snapshot hash. Result is small (one row per active
 * month, ~36–60 rows on prod data), JSON serde is fine — no Date
 * fields in the output.
 */

import { createHash } from "node:crypto";
import {
  srDsAbpReport,
  srDsGeneratorDetails,
} from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import {
  type CsvRow,
  type SnapshotSystem,
  clean,
  extractSnapshotSystems,
  parseAbpAcSizeKw,
  parseDate,
  parseDateOnlineAsMidMonth,
  parseGeneratorDetailsAcSizeKw,
  parseNumber,
  parsePart2VerificationDate,
  resolvePart2ProjectIdentity,
} from "./aggregatorHelpers";
import {
  computeSystemSnapshotHash,
  getOrBuildSystemSnapshot,
  loadDatasetRows,
} from "./buildSystemSnapshot";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

// ---------------------------------------------------------------------------
// Output type — structurally identical to `PipelineMonthRow` in
// `client/src/solar-rec-dashboard/state/types.ts`. The tab consumes
// the full shape unchanged.
// ---------------------------------------------------------------------------

export type PipelineMonthRow = {
  month: string;
  part1Count: number;
  part2Count: number;
  part1KwAc: number;
  part2KwAc: number;
  interconnectedCount: number;
  interconnectedKwAc: number;
  prevPart1Count: number;
  prevPart2Count: number;
  prevPart1KwAc: number;
  prevPart2KwAc: number;
  prevInterconnectedCount: number;
  prevInterconnectedKwAc: number;
};

// ---------------------------------------------------------------------------
// Pure aggregator — byte-for-byte mirror of the client useMemo body.
// ---------------------------------------------------------------------------

export function buildAppPipelineMonthly(input: {
  abpReportRows: CsvRow[];
  generatorDetailsRows: CsvRow[];
  systems: readonly SnapshotSystem[];
  /** Defaults to `new Date()`; injectable for deterministic tests. */
  now?: Date;
}): PipelineMonthRow[] {
  const {
    abpReportRows,
    generatorDetailsRows,
    systems,
    now = new Date(),
  } = input;

  type RawBucket = {
    part1Count: number;
    part2Count: number;
    part1KwAc: number;
    part2KwAc: number;
    interconnectedCount: number;
    interconnectedKwAc: number;
  };
  const buckets = new Map<string, RawBucket>();

  const ensureBucket = (month: string) => {
    if (!buckets.has(month)) {
      buckets.set(month, {
        part1Count: 0,
        part2Count: 0,
        part1KwAc: 0,
        part2KwAc: 0,
        interconnectedCount: 0,
        interconnectedKwAc: 0,
      });
    }
    return buckets.get(month)!;
  };

  const isFuture = (d: Date) => d > now;

  // Part 1 + Part 2 from abpReport.
  const seenPart1 = new Set<string>();
  const seenPart2 = new Set<string>();
  abpReportRows.forEach((row, index) => {
    const { dedupeKey } = resolvePart2ProjectIdentity(row, index);

    if (!seenPart1.has(dedupeKey)) {
      const submissionDate =
        parseDate(row.Part_1_submission_date) ??
        parseDate(row.Part_1_Submission_Date) ??
        parseDate(row.Part_1_Original_Submission_Date);
      if (submissionDate && !isFuture(submissionDate)) {
        seenPart1.add(dedupeKey);
        const month = `${submissionDate.getFullYear()}-${String(
          submissionDate.getMonth() + 1
        ).padStart(2, "0")}`;
        const bucket = ensureBucket(month);
        bucket.part1Count += 1;

        const acKw = parseNumber(row.Inverter_Size_kW_AC_Part_1);
        if (acKw !== null) bucket.part1KwAc += acKw;
      }
    }

    if (!seenPart2.has(dedupeKey)) {
      const part2DateRaw =
        clean(row.Part_2_App_Verification_Date) ||
        clean(row.part_2_app_verification_date);
      const verificationDate = parsePart2VerificationDate(part2DateRaw);
      if (verificationDate && !isFuture(verificationDate)) {
        seenPart2.add(dedupeKey);
        const month = `${verificationDate.getFullYear()}-${String(
          verificationDate.getMonth() + 1
        ).padStart(2, "0")}`;
        const bucket = ensureBucket(month);
        bucket.part2Count += 1;

        const acKw = parseAbpAcSizeKw(row);
        if (acKw !== null) bucket.part2KwAc += acKw;
      }
    }
  });

  // Interconnected from generatorDetails. Falls back to the snapshot's
  // `installedKwAc` per tracking ID when the row's own kW columns
  // don't yield a number.
  const fallbackAcKwByTrackingId = new Map<string, number>();
  for (const system of systems) {
    const trackingId = clean(system.trackingSystemRefId);
    // The client version reads `system.installedKwAc`, which the
    // canonical SnapshotSystem subset doesn't include — pull it
    // off the validated snapshot row.
    const installedKwAc = (system as Record<string, unknown>).installedKwAc;
    if (!trackingId || typeof installedKwAc !== "number") continue;
    if (!fallbackAcKwByTrackingId.has(trackingId)) {
      fallbackAcKwByTrackingId.set(trackingId, installedKwAc);
    }
  }

  const seenInterconnectedTrackingIds = new Set<string>();
  generatorDetailsRows.forEach((row) => {
    const trackingId =
      clean(row["GATS Unit ID"]) ||
      clean(row.gats_unit_id) ||
      clean(row["Unit ID"]) ||
      clean(row.unit_id);
    if (!trackingId || seenInterconnectedTrackingIds.has(trackingId)) return;

    const onlineDate =
      parseDateOnlineAsMidMonth(
        row["Date Online"] ??
          row["Date online"] ??
          row.date_online ??
          row.date_online_month_year
      ) ??
      parseDate(row.Interconnection_Approval_Date_UTC_Part_2) ??
      parseDate(row.Project_Online_Date_Part_2) ??
      parseDate(row["Date Online"] ?? row.date_online);
    if (!onlineDate || isFuture(onlineDate)) return;
    seenInterconnectedTrackingIds.add(trackingId);

    const month = `${onlineDate.getFullYear()}-${String(
      onlineDate.getMonth() + 1
    ).padStart(2, "0")}`;
    const bucket = ensureBucket(month);
    bucket.interconnectedCount += 1;

    const acKw =
      parseGeneratorDetailsAcSizeKw(row) ??
      fallbackAcKwByTrackingId.get(trackingId) ??
      null;
    if (acKw !== null) bucket.interconnectedKwAc += acKw;
  });

  // Build rows + prior-year comparison.
  const rawRows = Array.from(buckets.entries())
    .map(([month, data]) => ({ month, ...data }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const byMonth = new Map(rawRows.map((r) => [r.month, r]));

  return rawRows.map((row) => {
    const [yearStr, monthStr] = row.month.split("-");
    const prevMonth = `${Number(yearStr) - 1}-${monthStr}`;
    const prev = byMonth.get(prevMonth);
    return {
      ...row,
      prevPart1Count: prev?.part1Count ?? 0,
      prevPart2Count: prev?.part2Count ?? 0,
      prevPart1KwAc: prev?.part1KwAc ?? 0,
      prevPart2KwAc: prev?.part2KwAc ?? 0,
      prevInterconnectedCount: prev?.interconnectedCount ?? 0,
      prevInterconnectedKwAc: prev?.interconnectedKwAc ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Cached server entrypoint.
// ---------------------------------------------------------------------------

const APP_PIPELINE_MONTHLY_DEPS = ["abpReport", "generatorDetails"] as const;
const ARTIFACT_TYPE = "appPipelineMonthly";

export const APP_PIPELINE_MONTHLY_RUNNER_VERSION =
  "data-flow-pr5_13_apppipelinemonthly@1";

async function computeAppPipelineMonthlyInputHash(scopeId: string): Promise<{
  hash: string;
  abpReportBatchId: string | null;
  generatorDetailsBatchId: string | null;
}> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    APP_PIPELINE_MONTHLY_DEPS as unknown as string[]
  );
  const abpReportBatchId =
    versions.find((v) => v.datasetKey === "abpReport")?.batchId ?? null;
  const generatorDetailsBatchId =
    versions.find((v) => v.datasetKey === "generatorDetails")?.batchId ?? null;

  // System snapshot supplies `installedKwAc` for the interconnected
  // AC-kW fallback — bundling the snapshot hash means a snapshot
  // refresh re-aggregates pipeline rows that depended on it.
  const snapshotHash = await computeSystemSnapshotHash(scopeId);

  const hash = createHash("sha256")
    .update(
      [
        `abp:${abpReportBatchId ?? ""}`,
        `genDetails:${generatorDetailsBatchId ?? ""}`,
        `snapshot:${snapshotHash}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return { hash, abpReportBatchId, generatorDetailsBatchId };
}

export async function getOrBuildAppPipelineMonthly(
  scopeId: string
): Promise<{ rows: PipelineMonthRow[]; fromCache: boolean }> {
  const { hash, abpReportBatchId, generatorDetailsBatchId } =
    await computeAppPipelineMonthlyInputHash(scopeId);

  // No active abpReport AND no generatorDetails → empty result. Skip
  // the snapshot build that would otherwise be wasted.
  if (!abpReportBatchId && !generatorDetailsBatchId) {
    return { rows: [], fromCache: false };
  }

  const { result, fromCache } = await withArtifactCache<PipelineMonthRow[]>({
    scopeId,
    artifactType: ARTIFACT_TYPE,
    inputVersionHash: hash,
    serde: jsonSerde<PipelineMonthRow[]>(),
    rowCount: (rows) => rows.length,
    recompute: async () => {
      const [snapshot, abpReportRows, generatorDetailsRows] = await Promise.all([
        getOrBuildSystemSnapshot(scopeId),
        abpReportBatchId
          ? loadDatasetRows(scopeId, abpReportBatchId, srDsAbpReport)
          : Promise.resolve([] as CsvRow[]),
        generatorDetailsBatchId
          ? loadDatasetRows(
              scopeId,
              generatorDetailsBatchId,
              srDsGeneratorDetails
            )
          : Promise.resolve([] as CsvRow[]),
      ]);

      const systems = extractSnapshotSystems(snapshot.systems);
      return buildAppPipelineMonthly({
        abpReportRows,
        generatorDetailsRows,
        systems,
      });
    },
  });

  return { rows: result, fromCache };
}
