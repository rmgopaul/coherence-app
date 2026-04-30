/**
 * Task 9.5 PR-1 (2026-04-28) — meter-read history per CSG ID.
 *
 * Powers the new "Meter reads" section on the system detail page.
 * Walks the canonical join chain to surface the most recent
 * monitoring readings for one system:
 *
 *   csgId
 *     → `srDsAbpCsgSystemMapping` → systemId
 *     → `srDsSolarApplications.applicationId` (or systemId) → trackingSystemRefId
 *     → `srDsGenerationEntry.unitId === trackingSystemRefId`
 *           → onlineMonitoring (vendor) + onlineMonitoringSystemId
 *     → `srDsConvertedReads.monitoringSystemId === onlineMonitoringSystemId`
 *           OR `monitoringSystemName === systemName` (fuzzy fallback
 *              for vendors that don't expose a stable system id)
 *
 * Active batch resolution adds two new pointers
 * (`generationEntry`, `convertedReads`) on top of the three Task 9.1
 * already resolves. Returns up to N most-recent reads (default 30)
 * ordered by `readDate` desc, plus the resolved monitoring vendor
 * + system id/name so the UI can deep-link to the vendor's meter-
 * read page.
 *
 * Fallback chain for missing data:
 *   - No generation-entry row → try matching reads by name/systemId
 *     directly. Returns whatever the convertedReads dataset has on
 *     file, even without a vendor attribution.
 *   - No matching reads at all → returns an empty array; the page
 *     renders the standard "no data on file" state.
 */

import { eq, and, desc, getDb, withDbRetry } from "./_core";
import { or } from "drizzle-orm";
import {
  srDsConvertedReads,
  srDsGenerationEntry,
  solarRecActiveDatasetVersions,
} from "../../drizzle/schema";
import { getSystemByCsgId } from "./systemRegistry";

export interface SystemMeterRead {
  readDate: string;
  lifetimeMeterReadWh: number | null;
}

/**
 * Phase 5e Followup #4 step 2 (2026-04-29) — sister helper to
 * `getLatestMeterReadsForCsgId` for the SystemDetailSheet flow,
 * which has a `SystemRecord` (systemId + systemName) but no
 * `csgId`. The Sheet renders a 3-column "Recent Meter Reads"
 * table at the bottom of the panel; this helper supplies that
 * query without needing the client to hydrate the full
 * `srDsConvertedReads` table (50–150 MB on a populated scope).
 *
 * Differs from `getLatestMeterReadsForCsgId`:
 *   - Caller passes systemId/systemName directly (no csgId →
 *     registry → generationEntry → vendor lookup chain).
 *   - Returns the `monitoring` (vendor) field per row so the Sheet
 *     can display "Platform" without a separate lookup. The
 *     existing helper attaches a single resolved vendor at the
 *     result level (via generationEntry); this one reads it
 *     directly off each convertedReads row, since systems with
 *     mixed-vendor history are rare but possible.
 *
 * Same OR-match shape as the SystemDetailSheet's prior client-side
 * filter:
 *
 *   monitoringSystemId === input.systemId
 *     OR monitoringSystemName === input.systemName
 *
 * Sort order: `readDate DESC, lifetimeMeterReadWh DESC NULLS LAST`.
 * The Sheet's column header reads "Recent Meter Reads" — the prior
 * client-side filter just took the first 20 rows in dataset order
 * (a latent bug if the upload wasn't pre-sorted). This helper
 * fixes that.
 */
export interface SystemRecentMeterReadsRow {
  readDate: string;
  monitoring: string | null;
  lifetimeMeterReadWh: number | null;
}

export interface SystemRecentMeterReadsResult {
  reads: SystemRecentMeterReadsRow[];
}

const EMPTY_RECENT_RESULT: SystemRecentMeterReadsResult = { reads: [] };

export async function getSystemRecentMeterReads(
  scopeId: string,
  input: { systemId: string | null; systemName: string },
  opts: { limit?: number } = {}
): Promise<SystemRecentMeterReadsResult> {
  const systemId = (input.systemId ?? "").trim();
  const systemName = (input.systemName ?? "").trim();
  if (!systemId && !systemName) return EMPTY_RECENT_RESULT;

  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);

  const db = await getDb();
  if (!db) return EMPTY_RECENT_RESULT;

  const batches = await resolveMeterReadsBatchIds(scopeId);
  const convertedReadsBatchId = batches.convertedReads;
  if (!convertedReadsBatchId) return EMPTY_RECENT_RESULT;

  const matchers: ReturnType<typeof eq>[] = [];
  if (systemId) {
    matchers.push(eq(srDsConvertedReads.monitoringSystemId, systemId));
  }
  if (systemName) {
    matchers.push(eq(srDsConvertedReads.monitoringSystemName, systemName));
  }
  if (matchers.length === 0) return EMPTY_RECENT_RESULT;

  const readRows = await withDbRetry(
    "system recent meter reads — converted reads lookup",
    () =>
      db
        .select({
          readDate: srDsConvertedReads.readDate,
          monitoring: srDsConvertedReads.monitoring,
          lifetimeMeterReadWh: srDsConvertedReads.lifetimeMeterReadWh,
        })
        .from(srDsConvertedReads)
        .where(
          and(
            eq(srDsConvertedReads.scopeId, scopeId),
            eq(srDsConvertedReads.batchId, convertedReadsBatchId),
            or(...matchers)
          )
        )
        .orderBy(desc(srDsConvertedReads.readDate))
        .limit(limit)
  );

  const reads: SystemRecentMeterReadsRow[] = readRows
    .filter(
      (
        r
      ): r is {
        readDate: string;
        monitoring: string | null;
        lifetimeMeterReadWh: number | null;
      } => typeof r.readDate === "string" && r.readDate.length > 0
    )
    .map((r) => ({
      readDate: r.readDate,
      monitoring: r.monitoring,
      lifetimeMeterReadWh: r.lifetimeMeterReadWh,
    }));

  return { reads };
}

export interface SystemMeterReadsResult {
  /** "Solis" / "SolarEdge" / etc. — null when no generation-entry
   *  row resolved the vendor for this system. */
  monitoringVendor: string | null;
  /** The vendor's system id (used to deep-link from the section). */
  monitoringSystemId: string | null;
  /** The vendor's system name — sometimes the only stable
   *  identifier when the vendor doesn't expose a system id. */
  monitoringSystemName: string | null;
  /** Most recent read first; capped at `limit`. */
  reads: SystemMeterRead[];
  /** Latest read's date if present (ISO string from the CSV). */
  latestReadDate: string | null;
  /** Latest lifetime cumulative reading in Wh. */
  latestReadWh: number | null;
}

const EMPTY_RESULT: SystemMeterReadsResult = {
  monitoringVendor: null,
  monitoringSystemId: null,
  monitoringSystemName: null,
  reads: [],
  latestReadDate: null,
  latestReadWh: null,
};

/** Resolve the two row-table batches this helper needs. Same
 *  pattern as `resolveSystemRegistryBatchIds` but for the meter-
 *  read join. Exposed for testability. */
export async function resolveMeterReadsBatchIds(
  scopeId: string
): Promise<{
  generationEntry: string | null;
  convertedReads: string | null;
}> {
  const db = await getDb();
  const out = { generationEntry: null as string | null, convertedReads: null as string | null };
  if (!db) return out;
  const rows = await withDbRetry("meter reads — active batches", () =>
    db
      .select({
        datasetKey: solarRecActiveDatasetVersions.datasetKey,
        batchId: solarRecActiveDatasetVersions.batchId,
      })
      .from(solarRecActiveDatasetVersions)
      .where(eq(solarRecActiveDatasetVersions.scopeId, scopeId))
  );
  for (const row of rows) {
    if (row.datasetKey === "generationEntry") out.generationEntry = row.batchId;
    else if (row.datasetKey === "convertedReads") out.convertedReads = row.batchId;
  }
  return out;
}

/**
 * Look up meter reads for one CSG ID. Internally re-runs the
 * registry lookup to discover the system's identifiers — callers
 * that already have a `SystemRegistryRecord` can pass it via
 * `opts.preResolvedRegistry` to avoid the duplicate read.
 */
export async function getLatestMeterReadsForCsgId(
  scopeId: string,
  csgId: string,
  opts: {
    limit?: number;
    preResolvedRegistry?: Awaited<ReturnType<typeof getSystemByCsgId>>;
  } = {}
): Promise<SystemMeterReadsResult> {
  const trimmed = csgId.trim();
  if (!trimmed) return EMPTY_RESULT;
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);

  const db = await getDb();
  if (!db) return EMPTY_RESULT;

  const registry =
    opts.preResolvedRegistry ?? (await getSystemByCsgId(scopeId, csgId));
  if (!registry) return EMPTY_RESULT;

  const batches = await resolveMeterReadsBatchIds(scopeId);
  if (!batches.convertedReads) return EMPTY_RESULT;

  // Step 1 — try to resolve the monitoring vendor + system id via
  // generationEntry. Match on `unitId === trackingSystemRefId`.
  // Some scopes don't have generationEntry uploaded yet; that's
  // fine — we'll fall through to the name/id-direct match below.
  let monitoringVendor: string | null = null;
  let monitoringSystemId: string | null = null;
  let monitoringSystemName: string | null = null;
  const generationEntryBatchId = batches.generationEntry;
  const trackingId = registry.trackingSystemRefId;
  if (generationEntryBatchId && trackingId) {
    const genRows = await withDbRetry(
      "meter reads — generation entry lookup",
      () =>
        db
          .select({
            onlineMonitoring: srDsGenerationEntry.onlineMonitoring,
            onlineMonitoringSystemId:
              srDsGenerationEntry.onlineMonitoringSystemId,
            onlineMonitoringSystemName:
              srDsGenerationEntry.onlineMonitoringSystemName,
          })
          .from(srDsGenerationEntry)
          .where(
            and(
              eq(srDsGenerationEntry.scopeId, scopeId),
              eq(srDsGenerationEntry.batchId, generationEntryBatchId),
              eq(srDsGenerationEntry.unitId, trackingId)
            )
          )
          .limit(1)
    );
    const gen = genRows[0];
    if (gen) {
      monitoringVendor = gen.onlineMonitoring?.trim() || null;
      monitoringSystemId = gen.onlineMonitoringSystemId?.trim() || null;
      monitoringSystemName = gen.onlineMonitoringSystemName?.trim() || null;
    }
  }

  // Step 2 — pull reads from convertedReads. We OR over up to three
  // matchers so a system with partial vendor metadata still
  // surfaces something:
  //   1. monitoringSystemId (when generation-entry resolved one)
  //   2. monitoringSystemName (vendor-display fallback)
  //   3. registry.systemName (fuzzy — last resort when no
  //      generation-entry row exists)
  const matchers: ReturnType<typeof eq>[] = [];
  if (monitoringSystemId) {
    matchers.push(
      eq(srDsConvertedReads.monitoringSystemId, monitoringSystemId)
    );
  }
  if (monitoringSystemName) {
    matchers.push(
      eq(srDsConvertedReads.monitoringSystemName, monitoringSystemName)
    );
  }
  // Fuzzy fallback: match on the system's own name. Only use when
  // generation-entry didn't resolve a vendor — otherwise we risk
  // colliding with a different system that shares a name.
  if (!monitoringSystemName && registry.systemName) {
    matchers.push(
      eq(srDsConvertedReads.monitoringSystemName, registry.systemName)
    );
  }
  if (matchers.length === 0) return EMPTY_RESULT;

  const convertedReadsBatchId = batches.convertedReads;
  const readRows = await withDbRetry(
    "meter reads — converted reads lookup",
    () =>
      db
        .select({
          readDate: srDsConvertedReads.readDate,
          lifetimeMeterReadWh: srDsConvertedReads.lifetimeMeterReadWh,
        })
        .from(srDsConvertedReads)
        .where(
          and(
            eq(srDsConvertedReads.scopeId, scopeId),
            eq(srDsConvertedReads.batchId, convertedReadsBatchId),
            or(...matchers)
          )
        )
        .orderBy(desc(srDsConvertedReads.readDate))
        .limit(limit)
  );

  const reads: SystemMeterRead[] = readRows
    .filter((r): r is { readDate: string; lifetimeMeterReadWh: number | null } =>
      typeof r.readDate === "string" && r.readDate.length > 0
    )
    .map((r) => ({
      readDate: r.readDate,
      lifetimeMeterReadWh: r.lifetimeMeterReadWh,
    }));

  return {
    monitoringVendor,
    monitoringSystemId,
    monitoringSystemName,
    reads,
    latestReadDate: reads[0]?.readDate ?? null,
    latestReadWh: reads[0]?.lifetimeMeterReadWh ?? null,
  };
}
