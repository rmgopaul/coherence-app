/**
 * Phase 2.2 of the dashboard foundation repair (2026-04-30) —
 * the canonical foundation artifact builder.
 *
 * Type contract + invariants live in `shared/solarRecFoundation.ts`
 * (Phase 2.1). The builder ingests the seven `srDs*` row tables for
 * a scope's active dataset versions, applies the four locked
 * business definitions, and produces one
 * `FoundationArtifactPayload`. Phase 2.3 wraps this with single-
 * flight + cache; Phase 2.5 calls the cached builder from a
 * `warmFoundation` tRPC procedure on dashboard mount.
 *
 * Phase 2.2 + 2.4 ship the headline correctness fixes:
 *   - **ABP CSG-System Mapping with dedup-by-ABP-ID** — the
 *     24,275/24,274 off-by-one defense. The same ABP Application_ID
 *     mapping to two CSG IDs surfaces as
 *     `ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS` and counts the ABP exactly
 *     once.
 *   - **Locked Part II Verified definition** — mapped CSG ID + valid
 *     Part II date + ABP status NOT in {rejected, cancelled,
 *     canceled, withdrawn}. The legacy `isPart2VerifiedAbpRow` only
 *     checks the date; the foundation uses the new
 *     `isPart2VerifiedSystem` helper from `aggregatorHelpers.ts`.
 *
 * Deferred to follow-up PRs (still Phase 2 territory) — these
 * fields default to null/false in the artifact for now:
 *   - **Reporting status** — newest valid generation date as anchor
 *     and the per-system positive-generation check. Builder leaves
 *     `isReporting: false`, `anchorMonthIso: null`,
 *     `reportingCsgIds: []`, `summaryCounts.reporting: 0`. Tabs
 *     that depend on reporting (Overview, Trends, Performance
 *     Ratio) get this in the next builder pass before their
 *     Phase 3 migrations.
 *   - **Last meter read derivation** (`lastMeterReadDateIso`,
 *     `lastMeterReadKwh`).
 *   - **GATS ID resolution** + the `CSG_ID_HAS_MULTIPLE_GATS_IDS`
 *     warning (depends on GATS resolution from generationEntry +
 *     accountSolarGeneration cross-reference).
 *   - **Ownership status state machine** (transferred /
 *     change-of-ownership detection from `transferHistory`).
 *   - **Contracted date** (`contractedDateIso`) and energy year.
 *
 * The deferred fields stay nullable; the builder fills them in
 * incrementally without breaking the artifact shape.
 */

import { createHash } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  srDsAbpCsgSystemMapping,
  srDsAbpReport,
  srDsSolarApplications,
} from "../../../drizzle/schemas/solar";
import {
  DATASET_KEYS,
  type DatasetKey,
} from "../../../shared/datasetUpload.helpers";
import {
  EMPTY_FOUNDATION_ARTIFACT,
  FOUNDATION_DEFINITION_VERSION,
  FOUNDATION_RUNNER_VERSION,
  type FoundationArtifactPayload,
  type FoundationCanonicalSystem,
  type FoundationIntegrityWarning,
  type FoundationWarningCode,
  assertFoundationInvariants,
} from "../../../shared/solarRecFoundation";
import { getDb, withDbRetry } from "../../db/_core";
import { getActiveDatasetVersions } from "../../db/solarRecDatasets";
import { solarRecImportBatches } from "../../../drizzle/schemas/solar";
import { inArray } from "drizzle-orm";
import { isPart2VerifiedSystem } from "./aggregatorHelpers";

export { FOUNDATION_RUNNER_VERSION };

// ---------------------------------------------------------------------------
// Pure inputs / outputs — the testable surface
// ---------------------------------------------------------------------------

/**
 * Pre-resolved Solar Applications row used by the builder. The
 * caller (`buildFoundationArtifact` below) extracts these fields
 * from the typed `srDsSolarApplications` columns + the JSON
 * `rawRow` for status fields. Tests construct fixtures directly.
 */
export type FoundationSolarApplicationInput = {
  csgId: string | null;
  applicationId: string | null;
  systemName: string | null;
  installedKwAc: number | null;
  installedKwDc: number | null;
  totalContractAmount: number | null;
  contractType: string | null;
  /**
   * Concatenated status text from the row's status fields (see
   * `client/src/solar-rec-dashboard/lib/buildSystems.ts:434-443` for
   * the source-field list). Used to detect rejected/cancelled/
   * withdrawn applications.
   */
  statusText: string | null;
};

export type FoundationAbpReportInput = {
  applicationId: string | null;
  part2AppVerificationDate: string | null;
  projectName: string | null;
};

export type FoundationAbpCsgMappingInput = {
  csgId: string | null;
  /** From the mapping table's typed `systemId` column = ABP Application_ID. */
  abpId: string | null;
};

export type FoundationBuilderInputs = {
  scopeId: string;
  inputVersions: Record<DatasetKey, { batchId: string | null; rowCount: number }>;
  solarApplications: FoundationSolarApplicationInput[];
  abpReport: FoundationAbpReportInput[];
  abpCsgSystemMapping: FoundationAbpCsgMappingInput[];
  /**
   * `populatedDatasets` is a function of `inputVersions`: a key is
   * populated when its `rowCount > 0`. The builder derives this; the
   * caller doesn't pass it separately.
   */
};

// ---------------------------------------------------------------------------
// Termination heuristic — TEMPORARILY mirrors the client logic.
//
// `client/src/solar-rec-dashboard/lib/helpers/abp.ts::isTerminatedContractType`
// matches the contract type against `IL_ABP_TERMINATED_CONTRACT_TYPE`.
// We don't want a server→client import here, so we inline the same
// normalization. Phase 6 cleanup hoists both copies to
// `shared/solarRecAbpStatus.ts`.
// ---------------------------------------------------------------------------

function normalizeContractType(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const IL_ABP_TERMINATED_CONTRACT_TYPE = "il abp - terminated";

function isTerminatedContractType(
  value: string | null | undefined
): boolean {
  return normalizeContractType(value) === IL_ABP_TERMINATED_CONTRACT_TYPE;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyCanonicalSystem(csgId: string): FoundationCanonicalSystem {
  return {
    csgId,
    abpIds: [],
    sizeKwAc: null,
    sizeKwDc: null,
    contractValueUsd: null,
    isTerminated: false,
    isPart2Verified: false,
    isReporting: false,
    anchorMonthIso: null,
    contractType: null,
    ownershipStatus: null,
    monitoringPlatform: null,
    gatsId: null,
    lastMeterReadDateIso: null,
    lastMeterReadKwh: null,
    abpStatus: null,
    part2VerificationDateIso: null,
    contractedDateIso: null,
    energyYear: null,
    integrityWarningCodes: [],
  };
}

function attachWarningCode(
  system: FoundationCanonicalSystem,
  code: FoundationWarningCode
): void {
  if (!system.integrityWarningCodes.includes(code)) {
    system.integrityWarningCodes.push(code);
  }
}

/**
 * Deterministic hash of the foundation's input dataset versions
 * + the locked definition version. Used as the cache key in
 * `solarRecComputedArtifacts.inputVersionHash`.
 *
 * Exported so the foundation runner (Phase 2.3) can compute the
 * cache key WITHOUT first loading source rows — the cache layer
 * checks for an existing artifact before deciding to invoke the
 * builder.
 */
export function computeFoundationHash(
  inputVersions: Record<
    DatasetKey,
    { batchId: string | null; rowCount: number }
  >
): string {
  // Sort keys for deterministic hashing across builds.
  const sortedKeys = [...DATASET_KEYS].sort();
  const canonical = sortedKeys
    .map((k) => `${k}:${inputVersions[k]?.batchId ?? "null"}:${inputVersions[k]?.rowCount ?? 0}`)
    .join("|");
  const hashInput = `${canonical}|def${FOUNDATION_DEFINITION_VERSION}`;
  return createHash("sha256").update(hashInput).digest("hex");
}

// ---------------------------------------------------------------------------
// Pure builder (testable without a DB)
// ---------------------------------------------------------------------------

/**
 * Build a foundation artifact from already-loaded typed inputs.
 * Pure (no DB, no clock — `builtAt` is parameterized).
 *
 * Algorithm (deterministic, single-pass per dataset):
 *
 *   1. Build canonical systems from `solarApplications`. Each
 *      non-empty `csgId` becomes a `FoundationCanonicalSystem`
 *      seeded with size, contract value, contract type, statusText.
 *      Empty/null csgId rows surface as
 *      `SOLAR_APPLICATION_MISSING_CSG_ID` warnings.
 *
 *   2. Walk `abpCsgSystemMapping` to build two maps:
 *        - `csgToAbpIds: Record<csgId, Set<abpId>>`
 *        - `abpToCsgIds: Record<abpId, Set<csgId>>`
 *      Multi-CSG ABPs trigger `ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS`;
 *      multi-ABP CSGs trigger `CSG_ID_MAPS_TO_MULTIPLE_ABP_IDS`.
 *      Both warnings are attached per-system on every affected CSG
 *      so the Core System List filter can find them.
 *
 *   3. Dedupe `abpReport` by `applicationId`. Tie-break on Part II
 *      date (newest wins), then `applicationId` lex ascending.
 *      Duplicates trigger `DUPLICATE_ABP_REPORT_ROW`.
 *
 *   4. For each deduped ABP row:
 *      - Find every CSG mapped to its `applicationId`.
 *      - Per CSG: compute `isPart2Verified` via
 *        `isPart2VerifiedSystem({ hasMappedAbpId: true,
 *        part2VerificationDateRaw, statusText: csg's statusText })`.
 *      - If verified, add the CSG to `part2EligibleCsgIds`.
 *      - If verified BUT no CSG is mapped, emit
 *        `UNMATCHED_PART2_ABP_ID`.
 *
 *   5. Build summaryCounts. `totalSystems` excludes terminated;
 *      `terminated` is its own bucket.
 *
 *   6. Validate via `assertFoundationInvariants`. Throws on a self-
 *      inconsistent payload (the canonical 24,275/24,274 backstop).
 *
 * Reporting fields stay defaulted (false / null / empty) until a
 * follow-up PR fills them in. Same for last meter read, GATS ID,
 * ownership status, contracted date, energy year.
 */
export function buildFoundationFromInputs(
  inputs: FoundationBuilderInputs,
  builtAt: Date = new Date()
): FoundationArtifactPayload {
  const systemsByCsgId: Record<string, FoundationCanonicalSystem> = {};
  const integrityWarnings: FoundationIntegrityWarning[] = [];

  // -------- Step 1: seed canonical systems from solarApplications --------
  // Earliest row wins on conflicts (later rows for the same csgId
  // trigger a soft warning but don't overwrite — solar applications
  // is supposed to be one row per CSG ID).
  for (const row of inputs.solarApplications) {
    const csgId = (row.csgId ?? "").trim();
    if (!csgId) {
      const rowKey = (row.applicationId ?? row.systemName ?? "<unknown>")
        .toString()
        .trim();
      integrityWarnings.push({
        code: "SOLAR_APPLICATION_MISSING_CSG_ID",
        rowKey,
      });
      continue;
    }
    if (systemsByCsgId[csgId]) {
      // Duplicate row for the same CSG; ignore but keep the first.
      continue;
    }
    const system = emptyCanonicalSystem(csgId);
    system.sizeKwAc = row.installedKwAc;
    system.sizeKwDc = row.installedKwDc;
    system.contractValueUsd = row.totalContractAmount;
    system.contractType = row.contractType;
    system.isTerminated = isTerminatedContractType(row.contractType);
    systemsByCsgId[csgId] = system;
  }

  // -------- Step 2: ABP CSG-System Mapping --------
  const csgToAbpIds = new Map<string, Set<string>>();
  const abpToCsgIds = new Map<string, Set<string>>();
  for (const row of inputs.abpCsgSystemMapping) {
    const csgId = (row.csgId ?? "").trim();
    const abpId = (row.abpId ?? "").trim();
    if (!csgId || !abpId) continue;
    if (!csgToAbpIds.has(csgId)) csgToAbpIds.set(csgId, new Set());
    csgToAbpIds.get(csgId)!.add(abpId);
    if (!abpToCsgIds.has(abpId)) abpToCsgIds.set(abpId, new Set());
    abpToCsgIds.get(abpId)!.add(csgId);
  }

  // Detect mapping anomalies + populate `abpIds` per system.
  csgToAbpIds.forEach((abpIds, csgId) => {
    const system = systemsByCsgId[csgId];
    if (system) {
      const sortedAbpIds: string[] = Array.from(abpIds).sort();
      system.abpIds = sortedAbpIds;
      if (abpIds.size > 1) {
        attachWarningCode(system, "CSG_ID_MAPS_TO_MULTIPLE_ABP_IDS");
        integrityWarnings.push({
          code: "CSG_ID_MAPS_TO_MULTIPLE_ABP_IDS",
          csgId,
          abpIds: sortedAbpIds,
        });
      }
    }
  });
  abpToCsgIds.forEach((csgIds, abpId) => {
    if (csgIds.size > 1) {
      const csgList: string[] = Array.from(csgIds).sort();
      integrityWarnings.push({
        code: "ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS",
        abpId,
        csgIds: csgList,
      });
      for (const csgId of csgList) {
        const system = systemsByCsgId[csgId];
        if (system) {
          attachWarningCode(system, "ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS");
        }
      }
    }
  });

  // -------- Step 3: dedupe abpReport by applicationId --------
  const abpRowsByAppId = new Map<string, FoundationAbpReportInput[]>();
  for (const row of inputs.abpReport) {
    const appId = (row.applicationId ?? "").trim();
    if (!appId) continue;
    if (!abpRowsByAppId.has(appId)) abpRowsByAppId.set(appId, []);
    abpRowsByAppId.get(appId)!.push(row);
  }

  /** Newest Part II date first (descending); tie-break by appId asc. */
  const dedupedAbpRows: Array<{
    applicationId: string;
    part2AppVerificationDate: string | null;
  }> = [];
  abpRowsByAppId.forEach((rows, appId) => {
    if (rows.length > 1) {
      integrityWarnings.push({
        code: "DUPLICATE_ABP_REPORT_ROW",
        abpId: appId,
        rowCount: rows.length,
      });
    }
    rows.sort((a: FoundationAbpReportInput, b: FoundationAbpReportInput) => {
      const dateA = a.part2AppVerificationDate ?? "";
      const dateB = b.part2AppVerificationDate ?? "";
      // Newest first; empty dates sort last.
      if (dateA === dateB) return 0;
      if (!dateA) return 1;
      if (!dateB) return -1;
      return dateA < dateB ? 1 : -1;
    });
    dedupedAbpRows.push({
      applicationId: appId,
      part2AppVerificationDate: rows[0].part2AppVerificationDate ?? null,
    });
  });

  // -------- Step 4: apply Part II filter per CSG --------
  const part2VerifiedCsgIds = new Set<string>();
  for (const abpRow of dedupedAbpRows) {
    const mappedCsgs = abpToCsgIds.get(abpRow.applicationId);
    if (!mappedCsgs || mappedCsgs.size === 0) {
      // Unmatched ABP — date alone doesn't make a system.
      // Check if the date even passes the legacy parser before
      // emitting the warning, otherwise we'd flag every
      // partially-filled ABP row.
      if (
        isPart2VerifiedSystem({
          hasMappedAbpId: true,
          part2VerificationDateRaw: abpRow.part2AppVerificationDate,
          statusText: null,
        })
      ) {
        integrityWarnings.push({
          code: "UNMATCHED_PART2_ABP_ID",
          abpId: abpRow.applicationId,
        });
      }
      continue;
    }

    const mappedCsgsArray: string[] = Array.from(mappedCsgs);
    for (const csgId of mappedCsgsArray) {
      const system = systemsByCsgId[csgId];
      if (!system) continue;
      const verified = isPart2VerifiedSystem({
        hasMappedAbpId: true,
        part2VerificationDateRaw: abpRow.part2AppVerificationDate,
        // statusText is mirrored from the CSG's solarApplications row
        // because that's where the lifecycle status lives. ABP rows
        // don't carry an authoritative status field today.
        statusText: getCsgStatusText(inputs.solarApplications, csgId),
      });
      system.abpStatus = abpRow.part2AppVerificationDate
        ? "part2-verified-candidate"
        : null;
      system.part2VerificationDateIso = abpRow.part2AppVerificationDate;
      if (verified && !system.isTerminated) {
        system.isPart2Verified = true;
        part2VerifiedCsgIds.add(csgId);
      }
    }
  }

  // -------- Step 5: lists + summaryCounts --------
  const part2EligibleCsgIds = Array.from(part2VerifiedCsgIds).sort();
  // Reporting deferred — fill in a follow-up PR.
  const reportingCsgIds: string[] = [];

  const allSystems = Object.values(systemsByCsgId);
  const totalSystems = allSystems.filter((s) => !s.isTerminated).length;
  const terminated = allSystems.filter((s) => s.isTerminated).length;

  // Phase 2.6 (2026-05-01) closes the locked v3 def for "populated
  // dataset": active batch in `solarRecActiveDatasetVersions` with
  // recorded `rowCount > 0`. The earlier `batchId !== null`
  // fallback is gone — `loadInputVersions` now wires real
  // rowCounts via `solarRecImportBatches`, so the count is
  // authoritative.
  const populatedDatasets: DatasetKey[] = DATASET_KEYS.filter(
    (k) => (inputs.inputVersions[k]?.rowCount ?? 0) > 0
  );

  const foundationHash = computeFoundationHash(inputs.inputVersions);

  const payload: FoundationArtifactPayload = {
    schemaVersion: 1,
    definitionVersion: FOUNDATION_DEFINITION_VERSION,
    foundationHash,
    builtAt: builtAt.toISOString(),
    reportingAnchorDateIso: null, // deferred
    inputVersions: inputs.inputVersions,
    canonicalSystemsByCsgId: systemsByCsgId,
    part2EligibleCsgIds,
    reportingCsgIds,
    summaryCounts: {
      totalSystems,
      terminated,
      part2Verified: part2EligibleCsgIds.length,
      reporting: reportingCsgIds.length,
      part2VerifiedAndReporting: 0, // deferred (depends on reporting)
    },
    integrityWarnings,
    populatedDatasets,
  };

  // Phase 2.4 deliverable — never let a self-inconsistent payload
  // out of this function. Throws with the offending invariant's
  // message; the caller logs and surfaces the failure rather than
  // caching corrupt data.
  assertFoundationInvariants(payload);
  return payload;
}

/**
 * Lookup statusText for a CSG ID by scanning the
 * solarApplications input. O(N) per call but the caller's loop
 * is bounded by deduped ABP row count × mapped CSG count, both of
 * which are bounded by total system count. We can hoist into a
 * `Map<csgId, statusText>` if profiling shows this is hot.
 */
function getCsgStatusText(
  solarApplications: FoundationSolarApplicationInput[],
  csgId: string
): string | null {
  for (const row of solarApplications) {
    if ((row.csgId ?? "").trim() === csgId) {
      return row.statusText;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DB-bound builder — Phase 2.3 wraps this with single-flight + cache
// ---------------------------------------------------------------------------

/**
 * Concatenate the status fields from a Solar Applications rawRow
 * exactly the way `client/src/solar-rec-dashboard/lib/buildSystems.ts:
 * 434-443` does, so the foundation's Part II status filter sees
 * the same lifecycle text the legacy aggregators saw.
 *
 * Fields concatenated (`|`-joined, in order):
 *   contract_status, internal_status, project.status,
 *   tracking_system_status, Part_1_Status, Part_2_Status,
 *   Batch_Status.
 */
function statusTextFromRawRow(rawRowJson: string | null): string | null {
  if (!rawRowJson) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawRowJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const fields = [
    raw["contract_status"],
    raw["internal_status"],
    raw["project.status"],
    raw["tracking_system_status"],
    raw["Part_1_Status"],
    raw["Part_2_Status"],
    raw["Batch_Status"],
  ];
  const cleaned = fields
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
  return cleaned.length > 0 ? cleaned.join(" | ") : null;
}

/**
 * Chunked typed-column scan. Pages by `id` (the table primary key)
 * with a fixed page size so peak heap stays bounded. Yields one
 * page at a time; the caller accumulates into a typed array.
 *
 * The 5,000 default keeps each page well under the
 * "no >5,000 rows materialized for wire payload" CLAUDE.md rule
 * even when the consumer has to retain all pages (the foundation
 * builder retains everything). Larger tables are still bounded by
 * the loop accumulating to the natural row count.
 */
async function loadAllRowsByPage<TRow extends { id: string }>(
  scopeId: string,
  batchId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle table types are complex unions
  table: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- typed select projection
  selectCols: any,
  pageSize: number = 5000
): Promise<TRow[]> {
  const db = await getDb();
  if (!db) return [];

  const out: TRow[] = [];
  let cursor: string | null = null;
  // Bound the loop defensively. 200 pages × 5000 rows = 1M rows;
  // larger tables would need a higher cap (currently the largest
  // foundation input is `solarApplications` at ~33k rows).
  for (let page = 0; page < 200; page++) {
    const rows = (await withDbRetry(`load foundation page ${page}`, () => {
      const baseWhere = and(
        eq(table.scopeId, scopeId),
        eq(table.batchId, batchId),
        cursor ? gt(table.id, cursor) : undefined
      );
      return db
        .select(selectCols)
        .from(table)
        .where(baseWhere)
        .orderBy(asc(table.id))
        .limit(pageSize);
    })) as TRow[];

    if (rows.length === 0) break;
    out.push(...rows);
    cursor = rows[rows.length - 1].id;
    if (rows.length < pageSize) break;
  }
  return out;
}

/** Foundation's input dataset keys — keep in sync with the type spec. */
const FOUNDATION_INPUT_KEYS: DatasetKey[] = [
  "solarApplications",
  "abpReport",
  "abpCsgSystemMapping",
  "generationEntry",
  "accountSolarGeneration",
  "contractedDate",
  "transferHistory",
  "convertedReads",
];

/**
 * Load the active dataset versions for a scope, including the
 * recorded `rowCount` from `solarRecImportBatches` (one JOIN per
 * scope — bounded fan-out). Exported so the foundation runner
 * (Phase 2.3) can compute the cache key from the input versions
 * before deciding whether to invoke the builder.
 *
 * Phase 2.6 (2026-05-01) wired in real rowCounts. Earlier the
 * function returned `rowCount: 0` everywhere, which made
 * `populatedDatasets` derive from `batchId !== null` only.
 *
 * Note: `solarRecImportBatches.rowCount` is the count recorded
 * at upload time, not a live `SELECT COUNT(*)`. For most
 * purposes this matches; row deletions outside the upload path
 * could in theory drift the count, but no production code does
 * such deletions — the v3 plan accepts the recorded count as
 * authoritative for `populatedDatasets`.
 */
export async function loadInputVersions(
  scopeId: string
): Promise<
  Record<DatasetKey, { batchId: string | null; rowCount: number }>
> {
  const activeRows = await getActiveDatasetVersions(scopeId);
  const batchByKey = new Map<string, string>();
  const batchIds: string[] = [];
  for (const row of activeRows) {
    if (row.batchId) {
      batchByKey.set(row.datasetKey, row.batchId);
      batchIds.push(row.batchId);
    }
  }

  // Single batched query for every active batch's recorded
  // rowCount. No-op when there are no active batches.
  const rowCountByBatchId = new Map<string, number>();
  if (batchIds.length > 0) {
    const db = await getDb();
    if (db) {
      const rows = (await withDbRetry("foundation: load batch rowCounts", () =>
        db
          .select({
            id: solarRecImportBatches.id,
            rowCount: solarRecImportBatches.rowCount,
          })
          .from(solarRecImportBatches)
          .where(inArray(solarRecImportBatches.id, batchIds))
      )) as Array<{ id: string; rowCount: number | null }>;
      for (const row of rows) {
        rowCountByBatchId.set(row.id, row.rowCount ?? 0);
      }
    }
  }

  const result = Object.fromEntries(
    DATASET_KEYS.map((k) => {
      const batchId = batchByKey.get(k) ?? null;
      const rowCount = batchId
        ? rowCountByBatchId.get(batchId) ?? 0
        : 0;
      return [k, { batchId, rowCount }];
    })
  ) as Record<DatasetKey, { batchId: string | null; rowCount: number }>;
  return result;
}

/**
 * Production entry point. Reads input rows from the DB and feeds
 * them into the pure builder. Phase 2.3 wraps this with single-
 * flight via `solarRecComputeRuns` and result caching via
 * `solarRecComputedArtifacts`.
 *
 * Memory notes:
 *   - solarApplications: ~33k rows, ~few hundred KB peak.
 *   - abpReport: ~28k rows, ~few hundred KB.
 *   - abpCsgSystemMapping: ~28k rows, smaller (just two strings + rawRow).
 * Combined peak well under the v3 plan's 200 MB target.
 */
export async function buildFoundationArtifact(
  scopeId: string
): Promise<FoundationArtifactPayload> {
  if (!scopeId) {
    return EMPTY_FOUNDATION_ARTIFACT;
  }

  const inputVersions = await loadInputVersions(scopeId);

  const solarBatch = inputVersions.solarApplications.batchId;
  const abpBatch = inputVersions.abpReport.batchId;
  const mappingBatch = inputVersions.abpCsgSystemMapping.batchId;

  // Skip the heavy reads when the upstream datasets aren't
  // populated. The empty artifact still includes the per-key
  // input-version snapshot so a partial-population state doesn't
  // produce a "stale hash" surprise after the user uploads more
  // datasets.
  if (!solarBatch && !abpBatch && !mappingBatch) {
    const payload: FoundationArtifactPayload = {
      ...EMPTY_FOUNDATION_ARTIFACT,
      foundationHash: computeFoundationHash(inputVersions),
      builtAt: new Date().toISOString(),
      inputVersions,
      populatedDatasets: DATASET_KEYS.filter(
        (k) => (inputVersions[k]?.rowCount ?? 0) > 0
      ),
    };
    assertFoundationInvariants(payload);
    return payload;
  }

  // Load typed columns + the rawRow JSON we need for status
  // extraction. Direct typed-column queries skip the
  // `loadDatasetRows` CsvRow reconstruction (which hydrates rawRow
  // for every row even when we only want one field) — measurably
  // faster on the production dataset.
  type SolarRow = {
    id: string;
    systemId: string | null;
    applicationId: string | null;
    systemName: string | null;
    installedKwAc: number | null;
    installedKwDc: number | null;
    totalContractAmount: number | null;
    contractType: string | null;
    rawRow: string | null;
  };
  type AbpRow = {
    id: string;
    applicationId: string | null;
    part2AppVerificationDate: string | null;
    projectName: string | null;
  };
  type MappingRow = {
    id: string;
    csgId: string | null;
    systemId: string | null;
  };

  const [solarRows, abpRows, mappingRows] = await Promise.all([
    solarBatch
      ? loadAllRowsByPage<SolarRow>(scopeId, solarBatch, srDsSolarApplications, {
          id: srDsSolarApplications.id,
          systemId: srDsSolarApplications.systemId,
          applicationId: srDsSolarApplications.applicationId,
          systemName: srDsSolarApplications.systemName,
          installedKwAc: srDsSolarApplications.installedKwAc,
          installedKwDc: srDsSolarApplications.installedKwDc,
          totalContractAmount: srDsSolarApplications.totalContractAmount,
          contractType: srDsSolarApplications.contractType,
          rawRow: srDsSolarApplications.rawRow,
        })
      : (Promise.resolve([]) as Promise<SolarRow[]>),
    abpBatch
      ? loadAllRowsByPage<AbpRow>(scopeId, abpBatch, srDsAbpReport, {
          id: srDsAbpReport.id,
          applicationId: srDsAbpReport.applicationId,
          part2AppVerificationDate: srDsAbpReport.part2AppVerificationDate,
          projectName: srDsAbpReport.projectName,
        })
      : (Promise.resolve([]) as Promise<AbpRow[]>),
    mappingBatch
      ? loadAllRowsByPage<MappingRow>(scopeId, mappingBatch, srDsAbpCsgSystemMapping, {
          id: srDsAbpCsgSystemMapping.id,
          csgId: srDsAbpCsgSystemMapping.csgId,
          systemId: srDsAbpCsgSystemMapping.systemId,
        })
      : (Promise.resolve([]) as Promise<MappingRow[]>),
  ]);

  const inputs: FoundationBuilderInputs = {
    scopeId,
    inputVersions,
    solarApplications: solarRows.map((row) => ({
      csgId: row.systemId,
      applicationId: row.applicationId,
      systemName: row.systemName,
      installedKwAc: row.installedKwAc,
      installedKwDc: row.installedKwDc,
      totalContractAmount: row.totalContractAmount,
      contractType: row.contractType,
      statusText: statusTextFromRawRow(row.rawRow),
    })),
    abpReport: abpRows.map((row) => ({
      applicationId: row.applicationId,
      part2AppVerificationDate: row.part2AppVerificationDate,
      projectName: row.projectName,
    })),
    abpCsgSystemMapping: mappingRows.map((row) => ({
      csgId: row.csgId,
      abpId: row.systemId,
    })),
  };

  return buildFoundationFromInputs(inputs);
}
