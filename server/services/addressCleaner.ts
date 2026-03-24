/**
 * Deterministic US mailing address cleaner.
 *
 * Handles: casing, abbreviations, field-placement errors, state/zip validation,
 * phone number removal, placeholder values, cityStateZip parsing.
 *
 * Returns `{ cleaned, ambiguous }` — ambiguous rows need LLM review.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type AddressRow = {
  key: string;
  payeeName: string | null;
  mailingAddress1: string | null;
  mailingAddress2: string | null;
  cityStateZip: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

export type CleanedAddressRow = AddressRow & { ambiguous: boolean; ambiguousReason: string };

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const STREET_ABBREVIATIONS: Record<string, string> = {
  street: "St",
  avenue: "Ave",
  road: "Rd",
  boulevard: "Blvd",
  drive: "Dr",
  lane: "Ln",
  court: "Ct",
  parkway: "Pkwy",
  circle: "Cir",
  place: "Pl",
  terrace: "Ter",
  trail: "Trl",
  highway: "Hwy",
  way: "Way",
  apartment: "Apt",
  suite: "Ste",
};

const SECONDARY_UNIT_PREFIXES = /^(apt|ste|suite|unit|bldg|building|fl|floor|rm|room|dept|department|po\s*box|p\.?o\.?\s*box|#)\b/i;

const PLACEHOLDER_PATTERN = /^(n\.?a\.?|n\/a|tbd|unknown|none|null|-)$/i;

const PHONE_PATTERN = /^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/;

const ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "AS", "MP",
]);

// Business suffixes to keep uppercase
const PRESERVE_UPPER_PATTERN = /\b(LLC|INC|CORP|LTD|LP|LLP|PC|PA|DBA|CUPHD|HM2|NA|NV|II|III|IV)\b/gi;

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value.trim());
}

function isPhone(value: string): boolean {
  return PHONE_PATTERN.test(value.trim().replace(/\s+/g, ""));
}

function isZip(value: string): boolean {
  return ZIP_PATTERN.test(value.trim());
}

function isState(value: string): boolean {
  return US_STATES.has(value.trim().toUpperCase());
}

function isSecondaryUnit(value: string): boolean {
  return SECONDARY_UNIT_PREFIXES.test(value.trim());
}

function looksLikePersonName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 3) return false;
  // No digits → likely a name, not an address
  if (!/\d/.test(trimmed) && !/\b(po\s*box|p\.?o\.?\s*box)\b/i.test(trimmed)) {
    // Check if it starts with common name patterns
    const words = trimmed.split(/\s+/);
    if (words.length >= 2 && words.length <= 5 && !SECONDARY_UNIT_PREFIXES.test(trimmed)) {
      // Doesn't look like a street (no St/Ave/Rd/etc suffixes)
      const lastWord = words[words.length - 1].toLowerCase().replace(/\./g, "");
      const streetSuffixes = Object.keys(STREET_ABBREVIATIONS).concat(
        Object.values(STREET_ABBREVIATIONS).map((s) => s.toLowerCase())
      );
      if (!streetSuffixes.includes(lastWord)) {
        return true;
      }
    }
  }
  return false;
}

/** Title-case a string, preserving business acronyms */
function titleCase(value: string): string {
  if (!value.trim()) return value;

  // Store positions of preserved acronyms
  const preserved: Array<{ start: number; end: number; text: string }> = [];
  let match: RegExpExecArray | null;
  const preserveRegex = new RegExp(PRESERVE_UPPER_PATTERN.source, "gi");
  while ((match = preserveRegex.exec(value)) !== null) {
    preserved.push({ start: match.index, end: match.index + match[0].length, text: match[0].toUpperCase() });
  }

  // Title-case
  let result = value
    .toLowerCase()
    .replace(/(?:^|\s|[-/])\S/g, (char) => char.toUpperCase());

  // Restore preserved acronyms
  for (const item of preserved) {
    result = result.substring(0, item.start) + item.text + result.substring(item.end);
  }

  return result;
}

/** Standardize street abbreviations */
function standardizeAbbreviations(value: string): string {
  let result = value;
  for (const [full, abbr] of Object.entries(STREET_ABBREVIATIONS)) {
    // Match whole word, case-insensitive, with optional trailing period
    const regex = new RegExp(`\\b${full}\\.?\\b`, "gi");
    result = result.replace(regex, abbr);
  }
  // Fix double periods
  result = result.replace(/\.{2,}/g, ".").replace(/\.\s*$/, "");
  return result;
}

/** Parse "City, ST ZIP" or "City ST ZIP" patterns */
function parseCityStateZip(value: string): { city: string; state: string; zip: string } | null {
  const trimmed = clean(value);
  if (!trimmed) return null;

  // Pattern: "City, ST 12345" or "City, ST 12345-6789"
  const match1 = trimmed.match(/^(.+?),?\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
  if (match1) {
    const st = match1[2].toUpperCase();
    if (US_STATES.has(st)) {
      return { city: clean(match1[1]), state: st, zip: match1[3] };
    }
  }

  // Pattern: "City, ST" (no zip)
  const match2 = trimmed.match(/^(.+?),\s+([A-Za-z]{2})\s*$/);
  if (match2) {
    const st = match2[2].toUpperCase();
    if (US_STATES.has(st)) {
      return { city: clean(match2[1]), state: st, zip: "" };
    }
  }

  // Pattern: just a zip
  const matchZip = trimmed.match(/^(\d{5}(?:-\d{4})?)$/);
  if (matchZip) {
    return { city: "", state: "", zip: matchZip[1] };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Main cleaner                                                        */
/* ------------------------------------------------------------------ */

export function cleanAddressRow(row: AddressRow): CleanedAddressRow {
  let payeeName = clean(row.payeeName);
  let addr1 = clean(row.mailingAddress1);
  let addr2 = clean(row.mailingAddress2);
  let city = clean(row.city);
  let state = clean(row.state);
  let zip = clean(row.zip);
  const cityStateZipRaw = clean(row.cityStateZip);

  const ambiguousReasons: string[] = [];

  // ── Remove placeholders ──────────────────────────────────────
  if (isPlaceholder(payeeName)) payeeName = "";
  if (isPlaceholder(addr1)) addr1 = "";
  if (isPlaceholder(addr2)) addr2 = "";
  if (isPlaceholder(city)) city = "";
  if (isPlaceholder(state)) state = "";
  if (isPlaceholder(zip)) zip = "";

  // ── Remove phone numbers from address fields ─────────────────
  if (isPhone(addr2)) addr2 = "";
  if (isPhone(city)) city = "";
  if (isPhone(addr1)) { ambiguousReasons.push("Phone in addr1"); addr1 = ""; }

  // ── Zip in city field ────────────────────────────────────────
  if (isZip(city)) {
    if (!zip) zip = city;
    city = "";
  }

  // ── "USA" / "United States" / "Illinois 62701" in city ──────
  if (/^(usa|united\s*states)$/i.test(city)) city = "";
  const stateZipInCity = city.match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (stateZipInCity) {
    const potentialState = stateZipInCity[1].toUpperCase();
    if (US_STATES.has(potentialState)) {
      if (!state) state = potentialState;
      if (!zip) zip = stateZipInCity[2];
      city = "";
    }
  }

  // ── Parse cityStateZip fallback ──────────────────────────────
  if (cityStateZipRaw && (!city || !state || !zip)) {
    const parsed = parseCityStateZip(cityStateZipRaw);
    if (parsed) {
      if (!city) city = parsed.city;
      if (!state) state = parsed.state;
      if (!zip) zip = parsed.zip;
    }
  }

  // ── City/state/zip crammed into addr2 ────────────────────────
  if (addr2 && !isSecondaryUnit(addr2)) {
    const parsed = parseCityStateZip(addr2);
    if (parsed) {
      if (!city) city = parsed.city;
      if (!state) state = parsed.state;
      if (!zip) zip = parsed.zip;
      addr2 = "";
    }
  }

  // ── Entire address crammed into addr1 ────────────────────────
  if (addr1) {
    // Match: "123 Main St, City, ST 62701" or "123 Main St. City, IL. 62701"
    const crammedMatch = addr1.match(/^(.+?)[.,]\s*([A-Za-z\s]+?)[.,]?\s+([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)\s*$/);
    if (crammedMatch) {
      const potentialState = crammedMatch[3].toUpperCase();
      if (US_STATES.has(potentialState)) {
        addr1 = clean(crammedMatch[1]);
        if (!city) city = clean(crammedMatch[2]);
        if (!state) state = potentialState;
        if (!zip) zip = crammedMatch[4];
      }
    }
  }

  // ── Person name in addr1, real address in addr2 ──────────────
  if (addr1 && addr2 && looksLikePersonName(addr1) && /\d/.test(addr2)) {
    // addr1 looks like a name, addr2 looks like an address
    addr1 = addr2;
    addr2 = "";
  }

  // ── ATTN: prefix in addr1 ───────────────────────────────────
  if (/^attn:?\s*/i.test(addr1)) {
    if (addr2 && /\d/.test(addr2)) {
      // addr2 has the real address
      addr1 = addr2;
      addr2 = "";
    } else {
      addr1 = addr1.replace(/^attn:?\s*/i, "");
    }
  }

  // ── Duplicate addr1 === addr2 ────────────────────────────────
  if (addr1 && addr2 && addr1.toLowerCase().replace(/\s+/g, " ") === addr2.toLowerCase().replace(/\s+/g, " ")) {
    addr2 = "";
  }

  // ── Duplicate city in addr2 ──────────────────────────────────
  if (addr2 && city && addr2.toLowerCase().trim() === city.toLowerCase().trim()) {
    addr2 = "";
  }

  // ── Validate state ───────────────────────────────────────────
  if (state) {
    state = state.toUpperCase();
    if (!US_STATES.has(state)) {
      ambiguousReasons.push(`Invalid state '${state}'`);
      state = "";
    }
  }

  // ── Validate zip ─────────────────────────────────────────────
  if (zip) {
    // Strip non-digit/dash characters
    const cleanedZip = zip.replace(/[^\d-]/g, "");
    if (ZIP_PATTERN.test(cleanedZip)) {
      zip = cleanedZip;
    } else {
      ambiguousReasons.push(`Invalid zip '${zip}'`);
      zip = "";
    }
  }

  // ── Casing ───────────────────────────────────────────────────
  if (payeeName) payeeName = titleCase(payeeName);
  if (addr1) addr1 = titleCase(standardizeAbbreviations(addr1));
  if (addr2) addr2 = titleCase(standardizeAbbreviations(addr2));
  if (city) city = titleCase(city);

  // ── Flag as ambiguous if critical data is still missing ──────
  if (!addr1 && !ambiguousReasons.length) {
    ambiguousReasons.push("Missing street address");
  }
  if (addr1 && looksLikePersonName(addr1)) {
    ambiguousReasons.push("addr1 may be a person name");
  }

  return {
    key: row.key,
    payeeName: payeeName || null,
    mailingAddress1: addr1 || null,
    mailingAddress2: addr2 || null,
    cityStateZip: row.cityStateZip,
    city: city || null,
    state: state || null,
    zip: zip || null,
    ambiguous: ambiguousReasons.length > 0,
    ambiguousReason: ambiguousReasons.join("; "),
  };
}

/**
 * Clean a batch of address rows deterministically.
 * Returns { cleaned, ambiguousRows } — ambiguousRows should be sent to LLM.
 */
export function cleanAddressBatch(rows: AddressRow[]): {
  cleaned: CleanedAddressRow[];
  ambiguousRows: AddressRow[];
} {
  const cleaned: CleanedAddressRow[] = [];
  const ambiguousRows: AddressRow[] = [];

  for (const row of rows) {
    const result = cleanAddressRow(row);
    cleaned.push(result);
    if (result.ambiguous) {
      ambiguousRows.push(row);
    }
  }

  return { cleaned, ambiguousRows };
}
