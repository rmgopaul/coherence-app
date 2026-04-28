/**
 * Task 9.5 PR-3 (2026-04-28) — pure address comparison helpers for
 * the system detail page's Address section.
 *
 * Lives in `lib/` so the existing vitest `client/src/lib` glob
 * picks up the tests without expanding the include list. Both the
 * page and the test consume from here.
 *
 * The detail page has two partial address sources today:
 *
 *   1. **Solar Applications registry** — `county`, `state`,
 *      `zipCode`. No street address.
 *
 *   2. **Contract scan result** — `mailingAddress1`,
 *      `mailingAddress2`, `cityStateZip`, `payeeName`. Has street
 *      but `cityStateZip` is one free-text field.
 *
 * The comparison logic surfaces inconsistencies between the two
 * (e.g. contract was scanned with a ZIP that doesn't match Solar
 * Apps) so the team can flag follow-ups before the contract goes
 * to invoicing. No USPS API calls — those happen via the existing
 * Address Checker tool (`abpSettlement.verifyAddresses`).
 */

/** Outcome of comparing a single field across two sources. */
export type FieldMatchStatus =
  | "match"
  | "mismatch"
  | "missing-a"
  | "missing-b"
  | "missing-both";

export interface AddressComparison {
  /** Parsed ZIP from `contractScan.cityStateZip`. */
  contractZip: string | null;
  /** Parsed two-letter state code from `contractScan.cityStateZip`. */
  contractState: string | null;
  /** Parsed city from `contractScan.cityStateZip`. */
  contractCity: string | null;
  zipMatch: FieldMatchStatus;
  stateMatch: FieldMatchStatus;
  /** A coarse rollup the UI uses to color the section header.
   *  - `match` — every field present on both sides matches.
   *  - `mismatch` — at least one field disagrees.
   *  - `partial` — only one source has data; nothing to compare.
   *  - `none` — no address data on either side. */
  overall: "match" | "mismatch" | "partial" | "none";
}

interface ContractScanFields {
  mailingAddress1: string | null | undefined;
  mailingAddress2: string | null | undefined;
  cityStateZip: string | null | undefined;
  payeeName: string | null | undefined;
}

interface RegistryFields {
  state: string | null | undefined;
  zipCode: string | null | undefined;
  county: string | null | undefined;
}

/**
 * Parse a "City, ST 12345" or "City, ST 12345-6789" string into
 * its three components. Tolerant of:
 *   - extra whitespace, multiple commas
 *   - missing components (returns null for missing pieces)
 *   - 9-digit ZIPs (returns the 5-digit prefix)
 *   - lowercase state codes (uppercases on parse)
 *
 * Exposed for testability — see `addressCompare.test.ts` for
 * accepted inputs.
 */
export function parseCityStateZip(
  raw: string | null | undefined
): { city: string | null; state: string | null; zip: string | null } {
  if (!raw || typeof raw !== "string") {
    return { city: null, state: null, zip: null };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { city: null, state: null, zip: null };

  // Match the trailing "ST 12345" / "ST 12345-6789" first since
  // state codes are stable.
  const tail = trimmed.match(/([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*$/);
  let city: string | null = null;
  let state: string | null = null;
  let zip: string | null = null;
  if (tail) {
    state = tail[1].toUpperCase();
    zip = tail[2];
    const before = trimmed.slice(0, tail.index ?? 0).trim();
    // Drop trailing comma left behind by "City, ST 12345"
    city = before.replace(/,\s*$/, "").trim() || null;
  } else {
    // Fall back to a coarser parse: split on comma, last token may
    // be "ST 12345" or just "12345" or just "ST". Only the comma-
    // separated form is reliable; otherwise punt.
    const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      city = parts.slice(0, parts.length - 1).join(", ");
      const last = parts[parts.length - 1];
      const zipMatch = last.match(/(\d{5})/);
      const stateMatch = last.match(/\b([A-Za-z]{2})\b/);
      if (zipMatch) zip = zipMatch[1];
      if (stateMatch) state = stateMatch[1].toUpperCase();
    }
  }
  return { city, state, zip };
}

/** Normalize a ZIP value to the 5-digit prefix; returns null for
 *  unparseable input. Strips leading/trailing whitespace and any
 *  9-digit suffix. */
export function normalizeZip(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.toString().match(/(\d{5})/);
  return m ? m[1] : null;
}

/** Normalize a state value to a 2-letter uppercase code; returns
 *  null for unparseable input. */
export function normalizeState(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const upper = value.toString().trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

function compareField(
  a: string | null,
  b: string | null
): FieldMatchStatus {
  if (a === null && b === null) return "missing-both";
  if (a === null) return "missing-a";
  if (b === null) return "missing-b";
  return a === b ? "match" : "mismatch";
}

/** Compare contract scan vs registry, return per-field match
 *  statuses + an overall rollup. Pure. */
export function compareAddresses(
  contractScan: ContractScanFields | null | undefined,
  registry: RegistryFields | null | undefined
): AddressComparison {
  const parsed = parseCityStateZip(contractScan?.cityStateZip);
  const contractZip = normalizeZip(parsed.zip);
  const contractState = normalizeState(parsed.state);
  const contractCity = parsed.city;
  const registryZip = normalizeZip(registry?.zipCode);
  const registryState = normalizeState(registry?.state);

  const zipMatch = compareField(contractZip, registryZip);
  const stateMatch = compareField(contractState, registryState);

  // Rollup: partial when one side has nothing to compare; none when
  // neither side has anything; match/mismatch otherwise.
  const sides = [
    contractZip || contractState || contractCity || contractScan?.mailingAddress1,
    registryZip || registryState,
  ];
  const sideACount = sides[0] ? 1 : 0;
  const sideBCount = sides[1] ? 1 : 0;
  let overall: AddressComparison["overall"];
  if (sideACount === 0 && sideBCount === 0) {
    overall = "none";
  } else if (sideACount === 0 || sideBCount === 0) {
    overall = "partial";
  } else if (zipMatch === "mismatch" || stateMatch === "mismatch") {
    overall = "mismatch";
  } else {
    overall = "match";
  }

  return {
    contractZip,
    contractState,
    contractCity,
    zipMatch,
    stateMatch,
    overall,
  };
}
