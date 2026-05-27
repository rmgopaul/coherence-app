/**
 * Systems Index enrichments.
 *
 * Side-loads 10 per-system fields the snapshot doesn't carry,
 * plus the 2 derived fields the fact-row builder computes from
 * existing SystemRecord columns (`terminationCost`,
 * `deliveryEndDate`). Joined back to `solarRecDashboardSystemFacts`
 * by `systemKey` inside `buildDashboardSystemFacts`.
 *
 * Sources (5 datasets + 1 job-result table):
 *   - `srDsSolarApplications` typed cols (county / state / zip) +
 *     `rawRow` JSON parse (city / utility territory)
 *   - `srDsDeliverySchedule` typed col (`utilityContractNumber`) +
 *     `rawRow.year1_start_date`
 *   - `srDsTransferHistory` SUM(quantity) GROUP BY unitId
 *   - `srDsAccountSolarGeneration` MAX(lastMeterReadDate)
 *     per gatsGenId
 *   - `contractScanResults` latest scan per CSG ID
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  contractScanResults,
  solarRecActiveDatasetVersions,
  srDsAccountSolarGeneration,
  srDsDeliverySchedule,
  srDsSolarApplications,
  srDsTransferHistory,
} from "../../../drizzle/schema";
import { getDb, withDbRetry } from "../../db/_core";
import { parseDate } from "../../../client/src/solar-rec-dashboard/lib/parsers";
import { pickField } from "../core/datasetUploadParsers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemEnrichments {
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
  county: string | null;
  utilityTerritory: string | null;
  contractIdNumber: string | null;
  additionalCollateralPercent: number | null;
  deliveryStartDate: Date | null;
  totalTransferredMwh: number | null;
  lastMeterReadDate: Date | null;
}

export const EMPTY_SYSTEM_ENRICHMENTS: Readonly<SystemEnrichments> =
  Object.freeze({
    addressCity: null,
    addressState: null,
    addressZip: null,
    county: null,
    utilityTerritory: null,
    contractIdNumber: null,
    additionalCollateralPercent: null,
    deliveryStartDate: null,
    totalTransferredMwh: null,
    lastMeterReadDate: null,
  });

interface SystemIdentity {
  key: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
}

// ---------------------------------------------------------------------------
// Header aliases — `rawRow` JSON keys carry the original CSV headers, so
// we probe a few common forms.
// ---------------------------------------------------------------------------

const CITY_ALIASES = [
  "addressCity",
  "address_city",
  "system_city",
  "City",
  "city",
  "Project_City",
  "Project City",
] as const;

const UTILITY_ALIASES = [
  "utilityTerritory",
  "utility_territory",
  "Utility Territory",
  "Utility",
  "utility",
  "system_utility",
  "delivering_utility",
  "Delivering Utility",
] as const;

const YEAR1_START_ALIASES = ["year1_start_date", "Year 1 Start Date"] as const;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Extract the rawRow-only enrichment fields from a `srDsSolarApplications`
 * rawRow JSON string. Returns `{ addressCity, utilityTerritory }`; both
 * `null` when the row doesn't carry the value (or the JSON is malformed).
 */
export function extractSolarApplicationsRawFields(
  rawRowJson: string | null
): { addressCity: string | null; utilityTerritory: string | null } {
  if (!rawRowJson) return { addressCity: null, utilityTerritory: null };
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(rawRowJson) as Record<string, string>;
  } catch {
    return { addressCity: null, utilityTerritory: null };
  }
  return {
    addressCity: pickField(parsed, [...CITY_ALIASES]),
    utilityTerritory: pickField(parsed, [...UTILITY_ALIASES]),
  };
}

/**
 * Pull the `year1_start_date` cell out of a `srDsDeliverySchedule.rawRow`
 * JSON string and parse it. Returns `null` when missing or unparseable.
 */
export function extractDeliveryStartDate(
  rawRowJson: string | null
): Date | null {
  if (!rawRowJson) return null;
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(rawRowJson) as Record<string, string>;
  } catch {
    return null;
  }
  const raw = pickField(parsed, [...YEAR1_START_ALIASES]);
  return raw ? parseDate(raw) : null;
}

/**
 * Reduce a `contractScanResults`-ordered-DESC list to the newest
 * `additionalCollateralPercent` per `csgId`. The query is already
 * sorted; first occurrence wins. A null in the newest scan is
 * intentional (it signals the current contract has no additional
 * collateral); older non-null values from prior contract iterations
 * must NOT shadow it.
 */
export function dedupLatestCollateralByCsg(
  rows: ReadonlyArray<{ csgId: string; additionalCollateralPercent: number | null }>
): Map<string, number> {
  const out = new Map<string, number>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.csgId)) continue;
    seen.add(row.csgId);
    if (row.additionalCollateralPercent !== null) {
      out.set(row.csgId, row.additionalCollateralPercent);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public orchestrator
// ---------------------------------------------------------------------------

const DATASET_KEYS_NEEDED: ReadonlySet<string> = new Set([
  "solarApplications",
  "deliveryScheduleBase",
  "transferHistory",
  "accountSolarGeneration",
]);

export async function buildSystemEnrichments(
  scopeId: string,
  systems: ReadonlyArray<SystemIdentity>
): Promise<Map<string, SystemEnrichments>> {
  const out = new Map<string, SystemEnrichments>();
  if (systems.length === 0) return out;

  const db = await getDb();
  if (!db) {
    // EMPTY is frozen; the fact-row builder reads but does not mutate.
    for (const s of systems) out.set(s.key, EMPTY_SYSTEM_ENRICHMENTS);
    return out;
  }

  const activeVersions = await withDbRetry(
    "load active dataset versions (enrichments)",
    () =>
      db
        .select()
        .from(solarRecActiveDatasetVersions)
        .where(eq(solarRecActiveDatasetVersions.scopeId, scopeId))
  );
  const batchByDataset = new Map<string, string>();
  for (const v of activeVersions) {
    if (DATASET_KEYS_NEEDED.has(v.datasetKey)) {
      batchByDataset.set(v.datasetKey, v.batchId);
    }
  }

  // Contract scan results can carry a long tail of legacy CSG IDs;
  // narrowing the WHERE clause to systems currently in the snapshot
  // keeps the scan bounded.
  const systemIds = new Set<string>();
  for (const s of systems) {
    if (s.systemId) systemIds.add(s.systemId);
  }

  const [
    solarAppIndexes,
    scheduleByTracking,
    transferTotalByUnit,
    lastReadByGenId,
    collateralByCsg,
  ] = await Promise.all([
    loadSolarApplicationIndexes(
      db,
      scopeId,
      batchByDataset.get("solarApplications") ?? null
    ),
    loadDeliveryScheduleByTracking(
      db,
      scopeId,
      batchByDataset.get("deliveryScheduleBase") ?? null
    ),
    loadTransferTotalsByUnit(
      db,
      scopeId,
      batchByDataset.get("transferHistory") ?? null
    ),
    loadLastMeterReadByGenId(
      db,
      scopeId,
      batchByDataset.get("accountSolarGeneration") ?? null
    ),
    loadLatestCollateralByCsg(db, scopeId, systemIds),
  ]);
  const { byApplicationId, bySystemId, byTrackingId } = solarAppIndexes;

  for (const s of systems) {
    const enrich: SystemEnrichments = { ...EMPTY_SYSTEM_ENRICHMENTS };

    // Solar applications — try all 3 IDs.
    const solarApp =
      (s.stateApplicationRefId
        ? byApplicationId.get(s.stateApplicationRefId)
        : undefined) ??
      (s.systemId ? bySystemId.get(s.systemId) : undefined) ??
      (s.trackingSystemRefId
        ? byTrackingId.get(s.trackingSystemRefId)
        : undefined);
    if (solarApp) {
      enrich.county = solarApp.county;
      enrich.addressState = solarApp.state;
      enrich.addressZip = solarApp.zipCode;
      enrich.addressCity = solarApp.addressCity;
      enrich.utilityTerritory = solarApp.utilityTerritory;
    }

    // Delivery schedule — keyed on trackingSystemRefId.
    if (s.trackingSystemRefId) {
      const ds = scheduleByTracking.get(s.trackingSystemRefId);
      if (ds) {
        enrich.contractIdNumber = ds.utilityContractNumber;
        enrich.deliveryStartDate = ds.deliveryStartDate;
      }
    }

    // Transfer total — keyed on lowercased trackingSystemRefId (matches
    // the existing transferHistoryDeliveries lookup convention).
    if (s.trackingSystemRefId) {
      const sum = transferTotalByUnit.get(s.trackingSystemRefId.toLowerCase());
      if (sum !== undefined) enrich.totalTransferredMwh = sum;
    }

    // Last meter read date — keyed on lowercased gatsGenId
    // (== trackingSystemRefId per the user's identity clarification).
    // Lowercase to defend against vendor casing variance, mirroring
    // the transferHistory lookup convention.
    if (s.trackingSystemRefId) {
      const lmr = lastReadByGenId.get(s.trackingSystemRefId.toLowerCase());
      if (lmr) enrich.lastMeterReadDate = lmr;
    }

    // Additional collateral % — keyed on CSG ID (== systemId on
    // SystemRecord, since CSG ID is the canonical system identifier).
    if (s.systemId) {
      const c = collateralByCsg.get(s.systemId);
      if (c !== undefined) enrich.additionalCollateralPercent = c;
    }

    out.set(s.key, enrich);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

type DbClient = Awaited<ReturnType<typeof getDb>>;

interface SolarAppLookupRow {
  county: string | null;
  state: string | null;
  zipCode: string | null;
  addressCity: string | null;
  utilityTerritory: string | null;
}

interface SolarAppIndexes {
  byApplicationId: Map<string, SolarAppLookupRow>;
  bySystemId: Map<string, SolarAppLookupRow>;
  byTrackingId: Map<string, SolarAppLookupRow>;
}

async function loadSolarApplicationIndexes(
  db: DbClient,
  scopeId: string,
  batchId: string | null
): Promise<SolarAppIndexes> {
  // Duplicate IDs within a single active batch shouldn't happen in
  // practice; if they do, last-write-wins and the consumer reads the
  // most-recently-iterated row. Defensive ORDER BY skipped — the
  // active-batch filter already narrows to one import.
  const out: SolarAppIndexes = {
    byApplicationId: new Map(),
    bySystemId: new Map(),
    byTrackingId: new Map(),
  };
  if (!db || !batchId) return out;

  const rows = await withDbRetry("load solar applications (enrichments)", () =>
    db
      .select({
        applicationId: srDsSolarApplications.applicationId,
        systemId: srDsSolarApplications.systemId,
        trackingSystemRefId: srDsSolarApplications.trackingSystemRefId,
        county: srDsSolarApplications.county,
        state: srDsSolarApplications.state,
        zipCode: srDsSolarApplications.zipCode,
        rawRow: srDsSolarApplications.rawRow,
      })
      .from(srDsSolarApplications)
      .where(
        and(
          eq(srDsSolarApplications.scopeId, scopeId),
          eq(srDsSolarApplications.batchId, batchId)
        )
      )
  );

  for (const row of rows) {
    const { addressCity, utilityTerritory } = extractSolarApplicationsRawFields(
      row.rawRow ?? null
    );
    const lookup: SolarAppLookupRow = {
      county: row.county ?? null,
      state: row.state ?? null,
      zipCode: row.zipCode ?? null,
      addressCity,
      utilityTerritory,
    };
    if (row.applicationId) out.byApplicationId.set(row.applicationId, lookup);
    if (row.systemId) out.bySystemId.set(row.systemId, lookup);
    if (row.trackingSystemRefId)
      out.byTrackingId.set(row.trackingSystemRefId, lookup);
  }
  return out;
}

interface DeliveryScheduleLookup {
  utilityContractNumber: string | null;
  deliveryStartDate: Date | null;
}

async function loadDeliveryScheduleByTracking(
  db: DbClient,
  scopeId: string,
  batchId: string | null
): Promise<Map<string, DeliveryScheduleLookup>> {
  const out = new Map<string, DeliveryScheduleLookup>();
  if (!db || !batchId) return out;

  const rows = await withDbRetry("load delivery schedule (enrichments)", () =>
    db
      .select({
        trackingSystemRefId: srDsDeliverySchedule.trackingSystemRefId,
        utilityContractNumber: srDsDeliverySchedule.utilityContractNumber,
        rawRow: srDsDeliverySchedule.rawRow,
      })
      .from(srDsDeliverySchedule)
      .where(
        and(
          eq(srDsDeliverySchedule.scopeId, scopeId),
          eq(srDsDeliverySchedule.batchId, batchId)
        )
      )
  );

  for (const row of rows) {
    if (!row.trackingSystemRefId) continue;
    out.set(row.trackingSystemRefId, {
      utilityContractNumber: row.utilityContractNumber ?? null,
      deliveryStartDate: extractDeliveryStartDate(row.rawRow ?? null),
    });
  }
  return out;
}

async function loadTransferTotalsByUnit(
  db: DbClient,
  scopeId: string,
  batchId: string | null
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!db || !batchId) return out;

  const rows = await withDbRetry("load transfer totals (enrichments)", () =>
    db
      .select({
        unitId: srDsTransferHistory.unitId,
        total: sql<string>`SUM(${srDsTransferHistory.quantity})`.as("total"),
      })
      .from(srDsTransferHistory)
      .where(
        and(
          eq(srDsTransferHistory.scopeId, scopeId),
          eq(srDsTransferHistory.batchId, batchId)
        )
      )
      .groupBy(srDsTransferHistory.unitId)
  );

  for (const row of rows) {
    if (!row.unitId) continue;
    const sum = Number(row.total);
    if (Number.isFinite(sum)) {
      out.set(row.unitId.toLowerCase(), sum);
    }
  }
  return out;
}

async function loadLastMeterReadByGenId(
  db: DbClient,
  scopeId: string,
  batchId: string | null
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!db || !batchId) return out;

  // `lastMeterReadDate` is stored as varchar(32) so MAX in SQL would do
  // string comparison (only correct for ISO format). Load + parse + MAX
  // in JS so format variations are handled by `parseDate`.
  const rows = await withDbRetry("load last meter reads (enrichments)", () =>
    db
      .select({
        gatsGenId: srDsAccountSolarGeneration.gatsGenId,
        lastMeterReadDate: srDsAccountSolarGeneration.lastMeterReadDate,
      })
      .from(srDsAccountSolarGeneration)
      .where(
        and(
          eq(srDsAccountSolarGeneration.scopeId, scopeId),
          eq(srDsAccountSolarGeneration.batchId, batchId)
        )
      )
  );

  for (const row of rows) {
    if (!row.gatsGenId) continue;
    const parsed = parseDate(row.lastMeterReadDate ?? undefined);
    if (!parsed) continue;
    const key = row.gatsGenId.toLowerCase();
    const existing = out.get(key);
    if (!existing || parsed.getTime() > existing.getTime()) {
      out.set(key, parsed);
    }
  }
  return out;
}

async function loadLatestCollateralByCsg(
  db: DbClient,
  scopeId: string,
  csgIdsInUse: ReadonlySet<string>
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!db || csgIdsInUse.size === 0) return out;

  const rows = await withDbRetry("load contract scan collateral", () =>
    db
      .select({
        csgId: contractScanResults.csgId,
        additionalCollateralPercent:
          contractScanResults.additionalCollateralPercent,
        scannedAt: contractScanResults.scannedAt,
      })
      .from(contractScanResults)
      .where(
        and(
          eq(contractScanResults.scopeId, scopeId),
          inArray(contractScanResults.csgId, Array.from(csgIdsInUse))
        )
      )
      .orderBy(desc(contractScanResults.scannedAt))
  );

  return dedupLatestCollateralByCsg(
    rows.map((r) => ({
      csgId: r.csgId,
      additionalCollateralPercent:
        r.additionalCollateralPercent === null
          ? null
          : Number(r.additionalCollateralPercent),
    }))
  );
}
