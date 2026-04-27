/**
 * Shared helpers for the Task 5.13 server-side dashboard aggregators.
 *
 * Each aggregator file (`buildDeliveryTrackerData.ts`,
 * `buildTrendDeliveryPace.ts`, `buildContractVintageAggregates.ts`,
 * and any future siblings) used to inline `clean`, `parseNumber`,
 * `parseDate`, `toPercentValue`, etc. — the same five-line pure
 * functions copy-pasted three times. This module consolidates them
 * so the next aggregator imports rather than duplicates.
 *
 * Why server-local rather than `shared/`: the original `shared/`
 * objection was that moving the *client-side* helpers (which are
 * imported by ~50 files) would touch every consumer. That doesn't
 * apply here — these are server-internal helpers, not the same
 * symbols as the client's `parsers.ts` exports. They happen to be
 * byte-equivalent implementations, which is intentional: the matched
 * tests on each side guard against drift.
 */

import type { TransferDeliveryLookupPayload } from "./buildTransferDeliveryLookup";

/** CSV row shape returned by `loadDatasetRows`. */
export type CsvRow = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Pure parsing / formatting helpers — byte-equivalent to
// `client/src/solar-rec-dashboard/lib/parsers.ts` and `lib/helpers/parsing.ts`.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

export function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function parseNumber(value: string | undefined): number | null {
  const cleaned = clean(value).replace(/[$,%\s]/g, "").replaceAll(",", "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseDate(value: string | undefined): Date | null {
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
 * parsePart2VerificationDate`. Accepts Excel serial dates (5-digit
 * integers in a specific range) and calendar-formatted dates;
 * returns `null` for empty / "null" / out-of-range values.
 */
export function parsePart2VerificationDate(
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

export function isPart2VerifiedAbpRow(row: CsvRow): boolean {
  const part2VerifiedDateRaw =
    clean(row.Part_2_App_Verification_Date) ||
    clean(row.part_2_app_verification_date);
  return parsePart2VerificationDate(part2VerifiedDateRaw) !== null;
}

export function toPercentValue(
  numerator: number,
  denominator: number
): number | null {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null;
  }
  return (numerator / denominator) * 100;
}

/**
 * Look up the GATS transfer total credited to a (trackingId,
 * energyYear) bucket. Server-side `transferDeliveryLookup` is shaped
 * `Record<string, Record<string, number>>` (vs the client's
 * `Map<string, Map<number, number>>`); this helper hides the shape
 * so callers don't have to repeat the indirection.
 */
export function getDeliveredForYear(
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
// SystemRecord shape that the snapshot guarantees server-side. The
// canonical client-side type at
// `client/src/solar-rec-dashboard/state/types.ts` has many more
// fields; the aggregators here only read the subset listed below.
// `extractSnapshotSystems` runtime-validates each row and falls back
// to safe defaults for missing fields, so a future change to the
// snapshot's payload schema can't silently produce wrong aggregate
// numbers — the aggregator either reads a real value or treats the
// field as absent.
// ---------------------------------------------------------------------------

export type SnapshotSystem = {
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
  recPrice: number | null;
  isReporting: boolean;
};

/**
 * Validate + extract the `SnapshotSystem` subset from the
 * snapshot's `unknown[]` return shape. The snapshot is computed by
 * client-side TypeScript and serialized to JSON server-side, so
 * server consumers can't statically rely on its shape — they have
 * to validate. This is the single point where validation happens
 * for all aggregator consumers.
 *
 * Behaviour:
 *   - Non-object entries are skipped.
 *   - Each field falls back to a safe default (`null` for nullable
 *     strings/numbers, `false` for `isReporting`) if the field is
 *     missing or has the wrong type.
 *   - `trackingSystemRefId` is the only field that downstream
 *     aggregators currently filter on, so a missing value safely
 *     excludes the row from any tracking-id-keyed map.
 */
export function extractSnapshotSystems(
  systems: readonly unknown[]
): SnapshotSystem[] {
  const out: SnapshotSystem[] = [];
  for (const entry of systems) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    out.push({
      systemId: typeof r.systemId === "string" ? r.systemId : null,
      stateApplicationRefId:
        typeof r.stateApplicationRefId === "string"
          ? r.stateApplicationRefId
          : null,
      trackingSystemRefId:
        typeof r.trackingSystemRefId === "string"
          ? r.trackingSystemRefId
          : null,
      recPrice: typeof r.recPrice === "number" ? r.recPrice : null,
      isReporting: r.isReporting === true,
    });
  }
  return out;
}
