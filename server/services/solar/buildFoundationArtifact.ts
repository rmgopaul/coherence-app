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
 * Phase 2.7 (2026-05-01) extends the builder with reporting +
 * ownership state. The two new locked definitions:
 *   - **Reporting** — anchor = newest valid generation date across
 *     `srDsAccountSolarGeneration` ∪ `srDsGenerationEntry` where
 *     kWh > 0. Per-system `isReporting` = true iff the system has a
 *     positive generation reading inside `[firstDayOfAnchorMonth − 2
 *     calendar months, firstDayOfAnchorMonth + 1 calendar month)`,
 *     half-open, America/Chicago. Zero-production rows do not count.
 *     Transfer history never affects reporting.
 *   - **Ownership status** lifecycle bucket (4 states). Priority:
 *     `terminated` (contract type) > `transferred` (contract type
 *     OR transferHistory unitId match) > `change-of-ownership`
 *     (Zillow sold > contracted) > `active`. Tabs combine this with
 *     `isReporting` for the legacy 6-state UI enum.
 *
 * Still deferred (separate follow-up):
 *   - **GATS ID resolution** + the `CSG_ID_HAS_MULTIPLE_GATS_IDS`
 *     warning.
 *   - **Monitoring platform** + **energy year**.
 *
 * The deferred fields stay nullable; the builder fills them in
 * incrementally without breaking the artifact shape.
 */

import { createHash } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  srDsAbpCsgSystemMapping,
  srDsAbpReport,
  srDsAccountSolarGeneration,
  srDsContractedDate,
  srDsGenerationEntry,
  srDsSolarApplications,
  srDsTransferHistory,
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
import { parseIsoDate, toNullableNumber } from "./helpers";

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
  /**
   * Tracking-system ref ID — the linkage column that joins solar
   * applications to generation/transfer rows. Same value appears
   * as `gatsGenId` on `srDsAccountSolarGeneration` and `unitId` on
   * `srDsGenerationEntry` + `srDsTransferHistory`.
   */
  trackingSystemRefId: string | null;
  /** Zillow sold date (`Zillow_Sold_Date`) from the row's `rawRow` JSON. */
  zillowSoldDate: string | null;
  /** Zillow status text (`Zillow_Status` or nested `zillowData.status`). */
  zillowStatus: string | null;
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

/**
 * Account Solar Generation row. `gatsGenId` is the join column to
 * `solarApplications.trackingSystemRefId`. Both date columns are
 * canonical ISO strings (`yyyy-mm-dd`) on production data.
 */
export type FoundationAccountSolarGenerationInput = {
  gatsGenId: string | null;
  monthOfGeneration: string | null;
  lastMeterReadDate: string | null;
  lastMeterReadKwh: number | null;
};

/**
 * Generation Entry row. `unitId` is the join column to
 * `solarApplications.trackingSystemRefId`. The kWh value isn't a
 * typed column (legacy parses it from `GENERATION_BASELINE_VALUE_HEADERS`
 * in `rawRow`), so the DB-bound builder pre-extracts it before
 * passing to the pure builder.
 */
export type FoundationGenerationEntryInput = {
  unitId: string | null;
  lastMonthOfGen: string | null;
  effectiveDate: string | null;
  /** kWh value extracted from the row's rawRow (any of the 7 GENERATION_BASELINE_VALUE_HEADERS). */
  generationKwh: number | null;
};

export type FoundationTransferHistoryInput = {
  unitId: string | null;
  transferCompletionDate: string | null;
};

export type FoundationContractedDateInput = {
  csgId: string | null;
  contractedDate: string | null;
};

export type FoundationBuilderInputs = {
  scopeId: string;
  inputVersions: Record<DatasetKey, { batchId: string | null; rowCount: number }>;
  solarApplications: FoundationSolarApplicationInput[];
  abpReport: FoundationAbpReportInput[];
  abpCsgSystemMapping: FoundationAbpCsgMappingInput[];
  accountSolarGeneration: FoundationAccountSolarGenerationInput[];
  generationEntry: FoundationGenerationEntryInput[];
  transferHistory: FoundationTransferHistoryInput[];
  contractedDate: FoundationContractedDateInput[];
  /**
   * `populatedDatasets` is a function of `inputVersions`: a key is
   * populated when its `rowCount > 0`. The builder derives this; the
   * caller doesn't pass it separately.
   */
};

// ---------------------------------------------------------------------------
// Contract type heuristics — TEMPORARILY mirror the client logic.
//
// `client/src/solar-rec-dashboard/lib/helpers/abp.ts::isTerminatedContractType`
// + `isTransferredContractType` match against constants defined in
// `client/src/solar-rec-dashboard/lib/constants.ts:91-92`. Server→client
// imports aren't allowed, so we inline the same normalization.
// Phase 6 cleanup hoists both copies to `shared/solarRecAbpStatus.ts`.
// ---------------------------------------------------------------------------

function normalizeContractType(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const IL_ABP_TERMINATED_CONTRACT_TYPE = "il abp - terminated";
const IL_ABP_TRANSFERRED_CONTRACT_TYPE = "il abp - transferred";

function isTerminatedContractType(
  value: string | null | undefined
): boolean {
  return normalizeContractType(value) === IL_ABP_TERMINATED_CONTRACT_TYPE;
}

function isTransferredContractType(
  value: string | null | undefined
): boolean {
  return normalizeContractType(value) === IL_ABP_TRANSFERRED_CONTRACT_TYPE;
}

// ---------------------------------------------------------------------------
// Date helpers — month-level arithmetic on ISO `yyyy-mm-dd` strings.
//
// `parseIsoDate` + `shiftIsoDate` (days only) live in
// `server/services/solar/helpers.ts`. The reporting window math
// needs month-level shifts, which aren't there today. Inlining
// rather than hoisting keeps Phase 2.7 surgical; if a third caller
// needs month math, the helper hoists then.
// ---------------------------------------------------------------------------

/** First day of the month containing `dateIso`, formatted as `yyyy-mm-01`. */
function firstDayOfMonthIso(dateIso: string): string | null {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) return null;
  return `${parsed.year}-${String(parsed.month).padStart(2, "0")}-01`;
}

/**
 * Shift `dateIso` by `deltaMonths` calendar months and return the
 * first day of the resulting month. Always returns `yyyy-mm-01`.
 * Uses the JS Date constructor in local time — safe because we
 * normalize to a day-zero-time anchor and only read year/month back.
 */
function shiftIsoMonth(dateIso: string, deltaMonths: number): string | null {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) return null;
  const date = new Date(parsed.year, parsed.month - 1, 1);
  date.setMonth(date.getMonth() + deltaMonths);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/**
 * Pull the typed-column candidates in priority order, return the first
 * one that parses to a valid `yyyy-mm-dd` ISO string. Used to pick the
 * "reporting date" for an account-solar-generation or generation-entry
 * row when multiple date columns may be present.
 *
 * Lex comparison on `yyyy-mm-dd` strings is correct for ordering.
 */
function pickFirstValidIsoDate(
  candidates: Array<string | null | undefined>
): string | null {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const trimmed = c.trim();
    if (!trimmed) continue;
    if (parseIsoDate(trimmed)) return trimmed;
  }
  return null;
}

/**
 * Extract kWh from a generation-entry rawRow JSON. Tries the seven
 * `GENERATION_BASELINE_VALUE_HEADERS` from
 * `client/src/solar-rec-dashboard/lib/constants.ts:127`. Returns the
 * first parseable value, or null.
 */
const GENERATION_BASELINE_VALUE_HEADERS = [
  "Last Meter Read (kWh)",
  "Last Meter Read (kW)",
  "Last Meter Read",
  "Most Recent Production (kWh)",
  "Most Recent Production",
  "Generation (kWh)",
  "Production (kWh)",
] as const;

function extractGenerationEntryKwh(rawRowJson: string | null): number | null {
  if (!rawRowJson) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawRowJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const header of GENERATION_BASELINE_VALUE_HEADERS) {
    const parsed = toNullableNumber(raw[header]);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Extract Zillow status + sold date from a Solar Applications rawRow
 * JSON. Field aliases per the v3 plan:
 *   - status: `Zillow_Status` (flat) or `zillowData.status` (nested)
 *   - sold date: `Zillow_Sold_Date`
 */
function extractZillowFromRawRow(rawRowJson: string | null): {
  zillowStatus: string | null;
  zillowSoldDate: string | null;
} {
  if (!rawRowJson) return { zillowStatus: null, zillowSoldDate: null };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawRowJson) as Record<string, unknown>;
  } catch {
    return { zillowStatus: null, zillowSoldDate: null };
  }
  let status =
    typeof raw["Zillow_Status"] === "string"
      ? (raw["Zillow_Status"] as string).trim()
      : "";
  if (!status) {
    const nested = raw["zillowData"];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedStatus = (nested as Record<string, unknown>)["status"];
      if (typeof nestedStatus === "string") status = nestedStatus.trim();
    }
  }
  const soldDate =
    typeof raw["Zillow_Sold_Date"] === "string"
      ? (raw["Zillow_Sold_Date"] as string).trim()
      : "";
  return {
    zillowStatus: status || null,
    zillowSoldDate: soldDate || null,
  };
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

  // -------- Step 5: trackingSystemRefId / contractedDate / Zillow maps --------
  // First-non-null wins per CSG: a later solarApps row carrying the
  // tracking ref rescues a CSG whose first row was incomplete (otherwise
  // the system silently loses its generation linkage).
  //
  // Cross-CSG collision policy: if two CSGs claim the same trackingRef,
  // the FIRST claim (in row-iteration order) wins on the inverse map
  // and gets the generation linkage. Losing CSGs are tracked here so
  // we can emit `TRACKING_REF_COLLISION` warnings after the loop —
  // attributing generation rows to a deterministic owner is more
  // useful than silently last-write-wins, and the warning prompts
  // upstream cleanup.
  const csgIdByTrackingRef = new Map<string, string>();
  const trackingRefByCsgId = new Map<string, string>();
  const collisionCsgsByTrackingRef = new Map<string, Set<string>>();
  for (const row of inputs.solarApplications) {
    const csgId = (row.csgId ?? "").trim();
    if (!csgId) continue;
    const trackingRef = (row.trackingSystemRefId ?? "").trim();
    if (!trackingRef) continue;
    if (!trackingRefByCsgId.has(csgId)) {
      trackingRefByCsgId.set(csgId, trackingRef);
    }
    const existingOwner = csgIdByTrackingRef.get(trackingRef);
    if (existingOwner === undefined) {
      csgIdByTrackingRef.set(trackingRef, csgId);
    } else if (existingOwner !== csgId) {
      // Same trackingRef, different CSG — collision. Record both
      // (the existing owner + the loser); the warning lists every
      // claimant.
      let claimants = collisionCsgsByTrackingRef.get(trackingRef);
      if (!claimants) {
        claimants = new Set<string>([existingOwner]);
        collisionCsgsByTrackingRef.set(trackingRef, claimants);
      }
      claimants.add(csgId);
    }
  }

  // Emit collision warnings AFTER the full pass so each warning lists
  // every claimant (not just the second one we hit). Per-system codes
  // attached to every affected CSG so the Core System List filter
  // surfaces them.
  collisionCsgsByTrackingRef.forEach((claimants, trackingRef) => {
    const csgList: string[] = Array.from(claimants).sort();
    integrityWarnings.push({
      code: "TRACKING_REF_COLLISION",
      trackingRef,
      csgIds: csgList,
    });
    for (const csgId of csgList) {
      const system = systemsByCsgId[csgId];
      if (system) attachWarningCode(system, "TRACKING_REF_COLLISION");
    }
  });

  const contractedDateByCsgId = new Map<string, string>();
  for (const row of inputs.contractedDate) {
    const csgId = (row.csgId ?? "").trim();
    const date = (row.contractedDate ?? "").trim();
    if (!csgId || !date) continue;
    if (!contractedDateByCsgId.has(csgId)) {
      contractedDateByCsgId.set(csgId, date);
    }
  }

  // Zillow lookup maps: avoids the O(N×M) re-scan that `getCsgStatusText`
  // does for the Part II filter. Phase 6 cleanup hoists statusText to
  // the same map.
  //
  // Two independent first-non-null maps so a row carrying status only
  // doesn't lock out a later row carrying soldDate (or vice versa).
  // Real production data has been seen with the two fields split
  // across different solarApps rows for the same CSG; locking the
  // map on the first row with EITHER field would silently drop the
  // other field's later arrival → COO detection misses.
  const zillowStatusByCsgId = new Map<string, string>();
  const zillowSoldDateByCsgId = new Map<string, string>();
  for (const row of inputs.solarApplications) {
    const csgId = (row.csgId ?? "").trim();
    if (!csgId) continue;
    if (row.zillowStatus && !zillowStatusByCsgId.has(csgId)) {
      zillowStatusByCsgId.set(csgId, row.zillowStatus);
    }
    if (row.zillowSoldDate && !zillowSoldDateByCsgId.has(csgId)) {
      zillowSoldDateByCsgId.set(csgId, row.zillowSoldDate);
    }
  }

  // -------- Step 6: per-system generation accumulator --------
  // Track newest-positive-kWh date (anchor + isReporting) and newest
  // meter-read date (lastMeterReadDateIso) separately. Zero-production
  // rows still count as the latest meter read but never as positive
  // generation.
  type GenAccumulator = {
    latestPositiveGenDate: string | null;
    latestMeterReadDate: string | null;
    latestMeterReadKwh: number | null;
  };
  const genByCsgId = new Map<string, GenAccumulator>();
  let scopeLatestPositiveGenDate: string | null = null;

  function isoMaxDate(a: string | null, b: string | null): string | null {
    if (!a) return b;
    if (!b) return a;
    return a > b ? a : b;
  }

  function ensureGen(csgId: string): GenAccumulator {
    let acc = genByCsgId.get(csgId);
    if (!acc) {
      acc = {
        latestPositiveGenDate: null,
        latestMeterReadDate: null,
        latestMeterReadKwh: null,
      };
      genByCsgId.set(csgId, acc);
    }
    return acc;
  }

  function updateMeterRead(
    acc: GenAccumulator,
    date: string,
    kWh: number | null
  ): void {
    if (acc.latestMeterReadDate === null || date > acc.latestMeterReadDate) {
      acc.latestMeterReadDate = date;
      acc.latestMeterReadKwh = kWh;
    }
  }

  // Account Solar Generation: typed `lastMeterReadKwh` + `lastMeterReadDate`
  // (fallback `monthOfGeneration`) are sufficient — no rawRow parse needed.
  for (const row of inputs.accountSolarGeneration) {
    const trackingRef = (row.gatsGenId ?? "").trim();
    if (!trackingRef) continue;
    const csgId = csgIdByTrackingRef.get(trackingRef);
    if (!csgId) continue;
    const date = pickFirstValidIsoDate([
      row.lastMeterReadDate,
      row.monthOfGeneration,
    ]);
    if (!date) continue;
    const kWh = row.lastMeterReadKwh;
    const acc = ensureGen(csgId);
    updateMeterRead(acc, date, kWh);
    if (kWh !== null && kWh > 0) {
      acc.latestPositiveGenDate = isoMaxDate(acc.latestPositiveGenDate, date);
      scopeLatestPositiveGenDate = isoMaxDate(scopeLatestPositiveGenDate, date);
    }
  }

  // Generation Entry: kWh comes from rawRow (extracted upstream by the
  // DB-bound builder; tests pass it directly via `generationKwh`).
  for (const row of inputs.generationEntry) {
    const trackingRef = (row.unitId ?? "").trim();
    if (!trackingRef) continue;
    const csgId = csgIdByTrackingRef.get(trackingRef);
    if (!csgId) continue;
    const date = pickFirstValidIsoDate([row.lastMonthOfGen, row.effectiveDate]);
    if (!date) continue;
    const kWh = row.generationKwh;
    const acc = ensureGen(csgId);
    updateMeterRead(acc, date, kWh);
    if (kWh !== null && kWh > 0) {
      acc.latestPositiveGenDate = isoMaxDate(acc.latestPositiveGenDate, date);
      scopeLatestPositiveGenDate = isoMaxDate(scopeLatestPositiveGenDate, date);
    }
  }

  // -------- Step 7: reporting anchor + window --------
  const anchorMonthIso = scopeLatestPositiveGenDate
    ? firstDayOfMonthIso(scopeLatestPositiveGenDate)
    : null;
  const windowStartIso = anchorMonthIso ? shiftIsoMonth(anchorMonthIso, -2) : null;
  const windowEndIso = anchorMonthIso ? shiftIsoMonth(anchorMonthIso, 1) : null;

  // -------- Step 8: transferHistory → transferSeen flag --------
  const transferSeenByCsgId = new Set<string>();
  for (const row of inputs.transferHistory) {
    const trackingRef = (row.unitId ?? "").trim();
    if (!trackingRef) continue;
    const csgId = csgIdByTrackingRef.get(trackingRef);
    if (!csgId) continue;
    transferSeenByCsgId.add(csgId);
  }

  // -------- Step 9: project per-system reporting + ownership state --------
  for (const csgId of Object.keys(systemsByCsgId)) {
    const system = systemsByCsgId[csgId];

    const contracted = contractedDateByCsgId.get(csgId) ?? null;
    if (contracted) system.contractedDateIso = contracted;

    const gen = genByCsgId.get(csgId);
    if (gen) {
      system.lastMeterReadDateIso = gen.latestMeterReadDate;
      system.lastMeterReadKwh = gen.latestMeterReadKwh;
    }

    system.anchorMonthIso = anchorMonthIso;

    if (
      gen &&
      gen.latestPositiveGenDate &&
      windowStartIso &&
      windowEndIso &&
      gen.latestPositiveGenDate >= windowStartIso &&
      gen.latestPositiveGenDate < windowEndIso
    ) {
      system.isReporting = true;
    }

    const transferSeen = transferSeenByCsgId.has(csgId);
    const isContractTerminated = isTerminatedContractType(system.contractType);
    const isContractTransferred = isTransferredContractType(system.contractType);
    const zillowStatus = zillowStatusByCsgId.get(csgId);
    const zillowSoldDate = zillowSoldDateByCsgId.get(csgId);
    const isZillowSold =
      typeof zillowStatus === "string" &&
      zillowStatus.toLowerCase().includes("sold");
    const hasZillowConfirmedOwnershipChange =
      isZillowSold &&
      !!zillowSoldDate &&
      !!system.contractedDateIso &&
      zillowSoldDate > system.contractedDateIso;

    if (isContractTerminated) {
      system.ownershipStatus = "terminated";
    } else if (isContractTransferred || transferSeen) {
      system.ownershipStatus = "transferred";
    } else if (hasZillowConfirmedOwnershipChange) {
      system.ownershipStatus = "change-of-ownership";
    } else {
      system.ownershipStatus = "active";
    }
  }

  // -------- Step 10: lists + summaryCounts --------
  const part2EligibleCsgIds = Array.from(part2VerifiedCsgIds).sort();
  const reportingCsgIds = Object.values(systemsByCsgId)
    .filter((s) => s.isReporting && !s.isTerminated)
    .map((s) => s.csgId)
    .sort();
  const reportingCsgSet = new Set(reportingCsgIds);
  const part2VerifiedAndReporting = part2EligibleCsgIds.filter((id) =>
    reportingCsgSet.has(id)
  ).length;

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
    reportingAnchorDateIso: anchorMonthIso,
    inputVersions: inputs.inputVersions,
    canonicalSystemsByCsgId: systemsByCsgId,
    part2EligibleCsgIds,
    reportingCsgIds,
    summaryCounts: {
      totalSystems,
      terminated,
      part2Verified: part2EligibleCsgIds.length,
      reporting: reportingCsgIds.length,
      part2VerifiedAndReporting,
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
  const accountSolarGenBatch = inputVersions.accountSolarGeneration.batchId;
  const generationEntryBatch = inputVersions.generationEntry.batchId;
  const transferHistoryBatch = inputVersions.transferHistory.batchId;
  const contractedDateBatch = inputVersions.contractedDate.batchId;

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

  // Load typed columns + the rawRow JSON we need for status +
  // Zillow extraction. Direct typed-column queries skip the
  // `loadDatasetRows` CsvRow reconstruction (which hydrates rawRow
  // for every row even when we only want one field) — measurably
  // faster on the production dataset.
  type SolarRow = {
    id: string;
    systemId: string | null;
    applicationId: string | null;
    systemName: string | null;
    trackingSystemRefId: string | null;
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
  type AccountSolarGenRow = {
    id: string;
    gatsGenId: string | null;
    monthOfGeneration: string | null;
    lastMeterReadDate: string | null;
    lastMeterReadKwh: string | null;
  };
  type GenerationEntryRow = {
    id: string;
    unitId: string | null;
    lastMonthOfGen: string | null;
    effectiveDate: string | null;
    rawRow: string | null;
  };
  type TransferHistoryRow = {
    id: string;
    unitId: string | null;
    transferCompletionDate: string | null;
  };
  type ContractedDateRow = {
    id: string;
    systemId: string | null;
    contractedDate: string | null;
  };

  const [
    solarRows,
    abpRows,
    mappingRows,
    accountSolarGenRows,
    generationEntryRows,
    transferHistoryRows,
    contractedDateRows,
  ] = await Promise.all([
    solarBatch
      ? loadAllRowsByPage<SolarRow>(scopeId, solarBatch, srDsSolarApplications, {
          id: srDsSolarApplications.id,
          systemId: srDsSolarApplications.systemId,
          applicationId: srDsSolarApplications.applicationId,
          systemName: srDsSolarApplications.systemName,
          trackingSystemRefId: srDsSolarApplications.trackingSystemRefId,
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
    accountSolarGenBatch
      ? loadAllRowsByPage<AccountSolarGenRow>(
          scopeId,
          accountSolarGenBatch,
          srDsAccountSolarGeneration,
          {
            id: srDsAccountSolarGeneration.id,
            gatsGenId: srDsAccountSolarGeneration.gatsGenId,
            monthOfGeneration: srDsAccountSolarGeneration.monthOfGeneration,
            lastMeterReadDate: srDsAccountSolarGeneration.lastMeterReadDate,
            lastMeterReadKwh: srDsAccountSolarGeneration.lastMeterReadKwh,
          }
        )
      : (Promise.resolve([]) as Promise<AccountSolarGenRow[]>),
    generationEntryBatch
      ? loadAllRowsByPage<GenerationEntryRow>(
          scopeId,
          generationEntryBatch,
          srDsGenerationEntry,
          {
            id: srDsGenerationEntry.id,
            unitId: srDsGenerationEntry.unitId,
            lastMonthOfGen: srDsGenerationEntry.lastMonthOfGen,
            effectiveDate: srDsGenerationEntry.effectiveDate,
            rawRow: srDsGenerationEntry.rawRow,
          }
        )
      : (Promise.resolve([]) as Promise<GenerationEntryRow[]>),
    transferHistoryBatch
      ? loadAllRowsByPage<TransferHistoryRow>(
          scopeId,
          transferHistoryBatch,
          srDsTransferHistory,
          {
            id: srDsTransferHistory.id,
            unitId: srDsTransferHistory.unitId,
            transferCompletionDate: srDsTransferHistory.transferCompletionDate,
          }
        )
      : (Promise.resolve([]) as Promise<TransferHistoryRow[]>),
    contractedDateBatch
      ? loadAllRowsByPage<ContractedDateRow>(
          scopeId,
          contractedDateBatch,
          srDsContractedDate,
          {
            id: srDsContractedDate.id,
            systemId: srDsContractedDate.systemId,
            contractedDate: srDsContractedDate.contractedDate,
          }
        )
      : (Promise.resolve([]) as Promise<ContractedDateRow[]>),
  ]);

  const inputs: FoundationBuilderInputs = {
    scopeId,
    inputVersions,
    solarApplications: solarRows.map((row) => {
      const zillow = extractZillowFromRawRow(row.rawRow);
      return {
        csgId: row.systemId,
        applicationId: row.applicationId,
        systemName: row.systemName,
        installedKwAc: row.installedKwAc,
        installedKwDc: row.installedKwDc,
        totalContractAmount: row.totalContractAmount,
        contractType: row.contractType,
        statusText: statusTextFromRawRow(row.rawRow),
        trackingSystemRefId: row.trackingSystemRefId,
        zillowSoldDate: zillow.zillowSoldDate,
        zillowStatus: zillow.zillowStatus,
      };
    }),
    abpReport: abpRows.map((row) => ({
      applicationId: row.applicationId,
      part2AppVerificationDate: row.part2AppVerificationDate,
      projectName: row.projectName,
    })),
    abpCsgSystemMapping: mappingRows.map((row) => ({
      csgId: row.csgId,
      abpId: row.systemId,
    })),
    accountSolarGeneration: accountSolarGenRows.map((row) => ({
      gatsGenId: row.gatsGenId,
      monthOfGeneration: row.monthOfGeneration,
      lastMeterReadDate: row.lastMeterReadDate,
      lastMeterReadKwh: toNullableNumber(row.lastMeterReadKwh),
    })),
    generationEntry: generationEntryRows.map((row) => ({
      unitId: row.unitId,
      lastMonthOfGen: row.lastMonthOfGen,
      effectiveDate: row.effectiveDate,
      generationKwh: extractGenerationEntryKwh(row.rawRow),
    })),
    transferHistory: transferHistoryRows.map((row) => ({
      unitId: row.unitId,
      transferCompletionDate: row.transferCompletionDate,
    })),
    contractedDate: contractedDateRows.map((row) => ({
      csgId: row.systemId,
      contractedDate: row.contractedDate,
    })),
  };

  return buildFoundationFromInputs(inputs);
}
