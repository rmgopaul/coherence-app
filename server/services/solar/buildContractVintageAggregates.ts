/**
 * Server-side per-(contract, deliveryStartDate) aggregator. Shared
 * by `ContractsTab` and `AnnualReviewTab`.
 *
 * Task 5.13 PR-3 (2026-04-27) — moves
 *   - `client/src/solar-rec-dashboard/components/ContractsTab.tsx :: contractDeliveryRows`
 *   - `client/src/solar-rec-dashboard/components/AnnualReviewTab.tsx :: annualContractVintageRows`
 * onto the server. Both tabs were duplicating the same row-bucketing
 * pass over `deliveryScheduleBase.rows`. Output shape is the union of
 * what both tabs need (the previously-divergent fields:
 * `pricedProjectCount` for ContractsTab, `reportingProjectCount` +
 * `reportingProjectPercent` for AnnualReviewTab) so a single query
 * serves both tabs unchanged at the field level.
 *
 * The aggregator depends on three pieces of derived state that the
 * parent component used to compute and pass as props:
 *   - `eligibleTrackingIds` — Part-2-verified systems in the
 *     `solarApplications` ∪ `abpReport` cross-reference. Server
 *     replicates this filter from `abpReport` rows + the system
 *     snapshot (the same logic the parent runs in
 *     `part2EligibleSystemsForSizeReporting`).
 *   - `recPriceByTrackingId` / `isReportingByTrackingId` — per-tracking
 *     system attributes pulled from the same Part-2-eligible subset of
 *     the system snapshot.
 *   - `transferDeliveryLookup` — already cached server-side via
 *     `buildTransferDeliveryLookupForScope`.
 *
 * Cache is keyed by SHA-256 of (abpReport batch, snapshot hash,
 * deliveryScheduleBase batch, transferHistory batch). Recompute is
 * sub-second on prod-scale inputs.
 *
 * The matched test files (server side here, client side in the two
 * existing tab implementations) are the divergence detector: change
 * the server logic and the tab will render different numbers; the
 * unit tests in this file's sibling `.test.ts` and the structural
 * mirror against the original tab code are what guard against drift.
 */

import { createHash } from "node:crypto";
import { toDateKey } from "../../../shared/dateKey";
import {
  srDsAbpReport,
  srDsDeliverySchedule,
} from "../../../drizzle/schemas/solar";
import {
  getActiveVersionsForKeys,
  getComputedArtifact,
  upsertComputedArtifact,
} from "../../db/solarRecDatasets";
import { loadDatasetRows } from "./buildSystemSnapshot";
import {
  buildTransferDeliveryLookupForScope,
  type TransferDeliveryLookupPayload,
} from "./buildTransferDeliveryLookup";
import { computeSystemSnapshotHash, getOrBuildSystemSnapshot } from "./buildSystemSnapshot";

type CsvRow = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Inlined helpers — byte-equivalent to the client versions in
// `client/src/solar-rec-dashboard/lib/parsers.ts`,
// `client/src/solar-rec-dashboard/lib/helpers/parsing.ts`, and
// `client/src/solar-rec-dashboard/lib/helpers/abp.ts`. Kept inline rather
// than reaching into client/lib for the same reason as PR-1 + PR-2:
// migrating the client helpers to shared/ would touch ~50 files. Test
// files on both sides catch divergence.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseNumber(value: string | undefined): number | null {
  const cleaned = clean(value).replace(/[$,%\s]/g, "").replaceAll(",", "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: string | undefined): Date | null {
  const raw = clean(value);
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]) - 1;
    const day = Number(iso[3]);
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const usDateTime = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?)?$/
  );
  if (usDateTime) {
    const month = Number(usDateTime[1]) - 1;
    const day = Number(usDateTime[2]);
    const year =
      Number(usDateTime[3]) < 100
        ? 2000 + Number(usDateTime[3])
        : Number(usDateTime[3]);
    let hours = usDateTime[4] ? Number(usDateTime[4]) : 0;
    const minutes = usDateTime[5] ? Number(usDateTime[5]) : 0;
    const meridiem = usDateTime[6]?.toUpperCase();

    if (meridiem === "PM" && hours < 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;

    const date = new Date(year, month, day, hours, minutes);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Mirror of `client/src/solar-rec-dashboard/lib/helpers/parsing.ts ::
 * parsePart2VerificationDate`. Returns `null` for empty / "null" /
 * sentinel values; accepts Excel serial dates (5-digit integers in a
 * specific range) and calendar-formatted dates.
 */
function parsePart2VerificationDate(
  value: string | undefined
): Date | null {
  const raw = clean(value);
  if (!raw || raw.toLowerCase() === "null") return null;

  const excelSerial = raw.match(/^\d{5}(?:\.\d+)?$/);
  if (excelSerial) {
    const serial = Number(raw);
    if (Number.isFinite(serial) && serial >= 20_000 && serial <= 80_000) {
      const excelEpoch = new Date(Date.UTC(1899, 11, 30));
      const utcDate = new Date(
        excelEpoch.getTime() + Math.round(serial * DAY_MS)
      );
      const converted = new Date(
        utcDate.getUTCFullYear(),
        utcDate.getUTCMonth(),
        utcDate.getUTCDate()
      );
      const year = converted.getFullYear();
      if (year >= 2009 && year <= 2100) return converted;
    }
    return null;
  }

  const looksLikeCalendarDate =
    /(?:19|20)\d{2}/.test(raw) &&
    (raw.includes("/") || raw.includes("-") || /[A-Za-z]{3,9}/.test(raw));
  if (!looksLikeCalendarDate) return null;

  const parsed = parseDate(raw);
  if (!parsed) return null;
  const year = parsed.getFullYear();
  if (year < 2009 || year > 2100) return null;
  return parsed;
}

function isPart2VerifiedAbpRow(row: CsvRow): boolean {
  const part2VerifiedDateRaw =
    clean(row.Part_2_App_Verification_Date) ||
    clean(row.part_2_app_verification_date);
  return parsePart2VerificationDate(part2VerifiedDateRaw) !== null;
}

function toPercentValue(numerator: number, denominator: number): number | null {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null;
  }
  return (numerator / denominator) * 100;
}

function getDeliveredForYear(
  lookup: TransferDeliveryLookupPayload,
  trackingId: string,
  energyYear: number
): number {
  const byYear = lookup.byTrackingId[trackingId];
  if (!byYear) return 0;
  const value = byYear[String(energyYear)];
  return typeof value === "number" ? value : 0;
}

// ---------------------------------------------------------------------------
// Output type — superset of what either tab consumes. Both tabs receive
// the same array (sort orders + downstream roll-ups stay client-side).
// ---------------------------------------------------------------------------

export type ContractVintageAggregate = {
  contractId: string;
  /** Parsed delivery start date (year1_start_date). */
  deliveryStartDate: Date | null;
  /** Original raw string (for grouping by raw date when parse fails). */
  deliveryStartRaw: string;
  required: number;
  delivered: number;
  gap: number;
  deliveredPercent: number | null;
  requiredValue: number;
  deliveredValue: number;
  valueGap: number;
  valueDeliveredPercent: number | null;
  /** Unique tracking IDs in this group. */
  projectCount: number;
  /** Tracking IDs in this group with a known REC price (ContractsTab). */
  pricedProjectCount: number;
  /** Tracking IDs in this group whose system has `isReporting=true` (AnnualReviewTab). */
  reportingProjectCount: number;
  reportingProjectPercent: number | null;
};

// ---------------------------------------------------------------------------
// Pure aggregator — operates on already-derived inputs. Both tabs will
// consume the same return value; per-tab sort + downstream roll-ups stay
// client-side.
// ---------------------------------------------------------------------------

export function buildContractVintageAggregates(input: {
  scheduleRows: CsvRow[];
  eligibleTrackingIds: ReadonlySet<string>;
  recPriceByTrackingId: ReadonlyMap<string, number>;
  isReportingByTrackingId: ReadonlySet<string>;
  transferDeliveryLookup: TransferDeliveryLookupPayload;
}): ContractVintageAggregate[] {
  const {
    scheduleRows,
    eligibleTrackingIds,
    recPriceByTrackingId,
    isReportingByTrackingId,
    transferDeliveryLookup,
  } = input;

  const groups = new Map<
    string,
    {
      contractId: string;
      deliveryStartDate: Date | null;
      deliveryStartRaw: string;
      required: number;
      delivered: number;
      requiredValue: number;
      deliveredValue: number;
      trackingIds: Set<string>;
      pricedTrackingIds: Set<string>;
      reportingTrackingIds: Set<string>;
    }
  >();

  for (const row of scheduleRows) {
    const trackingId = clean(row.tracking_system_ref_id);
    if (!trackingId || !eligibleTrackingIds.has(trackingId)) continue;

    const contractId = clean(row.utility_contract_number) || "Unassigned";
    const deliveryStartRaw = clean(row.year1_start_date);
    if (!deliveryStartRaw) continue;

    const deliveryStartDate = parseDate(deliveryStartRaw);
    const required = parseNumber(row.year1_quantity_required) ?? 0;
    const delivered = deliveryStartDate
      ? getDeliveredForYear(
          transferDeliveryLookup,
          trackingId,
          deliveryStartDate.getFullYear()
        )
      : 0;
    const recPrice = recPriceByTrackingId.get(trackingId) ?? null;

    const dateKey = deliveryStartDate
      ? toDateKey(deliveryStartDate)
      : deliveryStartRaw;
    const key = `${contractId}__${dateKey}`;

    let current = groups.get(key);
    if (!current) {
      current = {
        contractId,
        deliveryStartDate,
        deliveryStartRaw,
        required: 0,
        delivered: 0,
        requiredValue: 0,
        deliveredValue: 0,
        trackingIds: new Set<string>(),
        pricedTrackingIds: new Set<string>(),
        reportingTrackingIds: new Set<string>(),
      };
      groups.set(key, current);
    }

    current.required += required;
    current.delivered += delivered;
    current.trackingIds.add(trackingId);
    if (recPrice !== null) {
      current.requiredValue += required * recPrice;
      current.deliveredValue += delivered * recPrice;
      current.pricedTrackingIds.add(trackingId);
    }
    if (isReportingByTrackingId.has(trackingId)) {
      current.reportingTrackingIds.add(trackingId);
    }
  }

  return Array.from(groups.values()).map((group) => ({
    contractId: group.contractId,
    deliveryStartDate: group.deliveryStartDate,
    deliveryStartRaw: group.deliveryStartRaw,
    required: group.required,
    delivered: group.delivered,
    gap: group.required - group.delivered,
    deliveredPercent: toPercentValue(group.delivered, group.required),
    requiredValue: group.requiredValue,
    deliveredValue: group.deliveredValue,
    valueGap: group.requiredValue - group.deliveredValue,
    valueDeliveredPercent: toPercentValue(
      group.deliveredValue,
      group.requiredValue
    ),
    projectCount: group.trackingIds.size,
    pricedProjectCount: group.pricedTrackingIds.size,
    reportingProjectCount: group.reportingTrackingIds.size,
    reportingProjectPercent: toPercentValue(
      group.reportingTrackingIds.size,
      group.trackingIds.size
    ),
  }));
  // No sort here — both tabs apply their own sort (one prefers
  // contractId-then-date, the other date-then-contractId).
}

// ---------------------------------------------------------------------------
// Server-side replication of the parent's
// `part2EligibleSystemsForSizeReporting` filter. The IDs used to match
// abpReport → systems mirror the client's three-way OR (portalSystemId
// ∨ applicationId ∨ trackingId).
// ---------------------------------------------------------------------------

type SnapshotSystem = {
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
  recPrice: number | null;
  isReporting: boolean;
};

function buildPart2EligibilityMaps(
  abpReportRows: CsvRow[],
  systems: readonly SnapshotSystem[]
): {
  eligibleTrackingIds: Set<string>;
  recPriceByTrackingId: Map<string, number>;
  isReportingByTrackingId: Set<string>;
} {
  const eligiblePart2ApplicationIds = new Set<string>();
  const eligiblePart2PortalSystemIds = new Set<string>();
  const eligiblePart2TrackingIds = new Set<string>();

  for (const row of abpReportRows) {
    if (!isPart2VerifiedAbpRow(row)) continue;
    const applicationId = clean(row.Application_ID);
    const portalSystemId = clean(row.system_id);
    const trackingId =
      clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) ||
      clean(row.tracking_system_ref_id);
    if (applicationId) eligiblePart2ApplicationIds.add(applicationId);
    if (portalSystemId) eligiblePart2PortalSystemIds.add(portalSystemId);
    if (trackingId) eligiblePart2TrackingIds.add(trackingId);
  }

  const eligibleTrackingIds = new Set<string>();
  const recPriceByTrackingId = new Map<string, number>();
  const isReportingByTrackingId = new Set<string>();

  for (const system of systems) {
    const byPortalSystemId = system.systemId
      ? eligiblePart2PortalSystemIds.has(system.systemId)
      : false;
    const byApplicationId = system.stateApplicationRefId
      ? eligiblePart2ApplicationIds.has(system.stateApplicationRefId)
      : false;
    const byTrackingId = system.trackingSystemRefId
      ? eligiblePart2TrackingIds.has(system.trackingSystemRefId)
      : false;

    if (!(byPortalSystemId || byApplicationId || byTrackingId)) continue;
    if (!system.trackingSystemRefId) continue;

    eligibleTrackingIds.add(system.trackingSystemRefId);
    if (system.recPrice !== null) {
      recPriceByTrackingId.set(system.trackingSystemRefId, system.recPrice);
    }
    if (system.isReporting) {
      isReportingByTrackingId.add(system.trackingSystemRefId);
    }
  }

  return {
    eligibleTrackingIds,
    recPriceByTrackingId,
    isReportingByTrackingId,
  };
}

// ---------------------------------------------------------------------------
// Cached server entrypoint.
// ---------------------------------------------------------------------------

const CONTRACT_VINTAGE_DEPS = ["abpReport", "deliveryScheduleBase"] as const;
const ARTIFACT_TYPE = "contractVintage";

export const CONTRACT_VINTAGE_RUNNER_VERSION =
  "data-flow-pr5_13_contractvintage@1";

async function computeContractVintageInputHash(
  scopeId: string
): Promise<{
  hash: string;
  abpReportBatchId: string | null;
  scheduleBatchId: string | null;
  snapshotHash: string;
}> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    CONTRACT_VINTAGE_DEPS as unknown as string[]
  );
  const abpReportBatchId =
    versions.find((v) => v.datasetKey === "abpReport")?.batchId ?? null;
  const scheduleBatchId =
    versions.find((v) => v.datasetKey === "deliveryScheduleBase")?.batchId ??
    null;

  // Snapshot hash bundles abpReport+other batch IDs already, but we
  // include it explicitly so any change to any input in the snapshot
  // (which our `recPrice`/`isReporting` reads depend on) bumps the
  // cache.
  const snapshotHash = await computeSystemSnapshotHash(scopeId);

  // transferHistory is read indirectly through the cached
  // `buildTransferDeliveryLookupForScope`; that helper's own cache
  // key includes the transferHistory batch, so we don't need to
  // separately include it here. (Cache invalidation propagates: a
  // new transferHistory batch invalidates the lookup, which on next
  // call recomputes; since the lookup payload contributes to the
  // aggregate output, we DO want the aggregate cache to invalidate
  // too — so we hash the lookup's `inputVersionHash` after retrieving
  // it.)

  // Lookup hash (cheap — only reads the active transferHistory
  // batch ID, doesn't fetch the full lookup).
  const transferVersions = await getActiveVersionsForKeys(scopeId, [
    "transferHistory",
  ]);
  const transferBatchId =
    transferVersions.find((v) => v.datasetKey === "transferHistory")
      ?.batchId ?? null;

  const hash = createHash("sha256")
    .update(
      [
        `abp:${abpReportBatchId ?? ""}`,
        `schedule:${scheduleBatchId ?? ""}`,
        `transfer:${transferBatchId ?? ""}`,
        `snapshot:${snapshotHash}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return { hash, abpReportBatchId, scheduleBatchId, snapshotHash };
}

/**
 * Public entrypoint for the tRPC query. Returns the same per-(contract,
 * deliveryStartDate) detail rows that ContractsTab and AnnualReviewTab
 * used to build locally.
 *
 * Cache hit path returns a previously-computed aggregate keyed by the
 * input batch hashes. Cache miss path:
 *   1. Loads system snapshot (already cached on its own).
 *   2. Loads abpReport rows.
 *   3. Computes Part-2 eligibility maps from snapshot + abpReport.
 *   4. Loads deliveryScheduleBase rows.
 *   5. Loads (cached) transfer-delivery lookup.
 *   6. Runs the pure aggregator.
 *   7. Writes back.
 *
 * superjson cache serde because `deliveryStartDate: Date | null` needs
 * to round-trip cleanly (same as PR-1).
 */
export async function getOrBuildContractVintageAggregates(
  scopeId: string
): Promise<{
  rows: ContractVintageAggregate[];
  fromCache: boolean;
}> {
  const { hash, abpReportBatchId, scheduleBatchId } =
    await computeContractVintageInputHash(scopeId);

  if (!scheduleBatchId) {
    // No delivery-schedule data → nothing to aggregate. Mirror the
    // client's empty-state behavior.
    return { rows: [], fromCache: false };
  }

  const cached = await getComputedArtifact(scopeId, ARTIFACT_TYPE, hash);
  if (cached) {
    try {
      // superjson preserves the `Date | null` field on each row.
      const { default: superjson } = await import("superjson");
      const parsed = superjson.parse<ContractVintageAggregate[]>(
        cached.payload
      );
      if (Array.isArray(parsed)) {
        return { rows: parsed, fromCache: true };
      }
    } catch {
      // Corrupt cache row — fall through to recompute.
    }
  }

  // Compute fresh.
  const [snapshot, abpReportRows, scheduleRows, transferLookup] =
    await Promise.all([
      getOrBuildSystemSnapshot(scopeId),
      abpReportBatchId
        ? loadDatasetRows(scopeId, abpReportBatchId, srDsAbpReport)
        : Promise.resolve([] as CsvRow[]),
      loadDatasetRows(scopeId, scheduleBatchId, srDsDeliverySchedule),
      buildTransferDeliveryLookupForScope(scopeId),
    ]);

  // The snapshot returns `unknown[]` server-side because SystemRecord
  // is typed in client-land; cast through SnapshotSystem (the subset
  // we need). The cache-hit path stores serialized JSON of these
  // fields, so this cast is safe whenever the snapshot is present.
  const systems = snapshot.systems as readonly SnapshotSystem[];

  const eligibilityMaps = buildPart2EligibilityMaps(abpReportRows, systems);

  const rows = buildContractVintageAggregates({
    scheduleRows,
    eligibleTrackingIds: eligibilityMaps.eligibleTrackingIds,
    recPriceByTrackingId: eligibilityMaps.recPriceByTrackingId,
    isReportingByTrackingId: eligibilityMaps.isReportingByTrackingId,
    transferDeliveryLookup: transferLookup,
  });

  try {
    const { default: superjson } = await import("superjson");
    await upsertComputedArtifact({
      scopeId,
      artifactType: ARTIFACT_TYPE,
      inputVersionHash: hash,
      payload: superjson.stringify(rows),
      rowCount: rows.length,
    });
  } catch (error) {
    // Best-effort cache write.
    console.warn(
      `[buildContractVintageAggregates] cache write failed:`,
      error instanceof Error ? error.message : error
    );
  }

  return { rows, fromCache: false };
}
