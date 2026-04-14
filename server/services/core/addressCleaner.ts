/**
 * Deterministic US mailing address cleaner.
 *
 * Handles: casing, abbreviations, field-placement errors, state/zip validation,
 * phone number removal, email removal, placeholder values, cityStateZip parsing,
 * stuck-together numbers+words, "Illinois"→"IL" expansion, duplicate fields,
 * city misspelling corrections.
 *
 * Returns `{ cleaned, ambiguousRows }` — ambiguous rows should be sent to LLM.
 */

import {
  resolveStateName,
  normalizeOrdinals,
  fixSpacing,
  parseCityStateZip,
  extractTrailingCityStateZip,
  correctStateForZip,
} from "./addressCleaning";

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
  street: "St", avenue: "Ave", road: "Rd", boulevard: "Blvd", drive: "Dr",
  lane: "Ln", court: "Ct", parkway: "Pkwy", circle: "Cir", place: "Pl",
  terrace: "Ter", trail: "Trl", highway: "Hwy", way: "Way",
  apartment: "Apt", suite: "Ste",
};

const SECONDARY_UNIT_PREFIXES = /^(apt|ste|suite|unit|bldg|building|fl|floor|rm|room|dept|department|po\s*box|p\.?o\.?\s*box|#|attn)\b/i;

const PLACEHOLDER_PATTERN = /^(n\.?a\.?|n\/a|tbd|unknown|none|null|-)$/i;

const PHONE_PATTERN = /(?:^|\s)\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?:\s|$)/;
const PHONE_STRICT = /^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/;
const PHONE_WITH_EXT = /^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(\s*(ext|x)\.?\s*\d+)?$/i;

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "AS", "MP",
]);

const PRESERVE_UPPER = /\b(LLC|INC|CORP|LTD|LP|LLP|PC|PA|DBA|CUPHD|HM2|NA|NV|II|III|IV|PO|RR|US|SE|NE|NW|SW)\b/gi;

/**
 * Known city misspellings/capitalization fixes from ABP data.
 * Key is lowercase, value is the corrected form.
 */
const CITY_CORRECTIONS: Record<string, string> = {
  "hillsde": "Hillside",
  "ofallon": "O'Fallon",
  "o'fallon": "O'Fallon",
  "dekalb": "DeKalb",
  "mchenry": "McHenry",
  "lagrange park": "La Grange Park",
  "lagrange": "La Grange",
  "milledgville": "Milledgeville",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ");
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value.trim());
}

function isPhone(value: string): boolean {
  return PHONE_STRICT.test(value.trim().replace(/\s+/g, "")) ||
    PHONE_WITH_EXT.test(value.trim());
}

function containsPhone(value: string): boolean {
  return PHONE_PATTERN.test(value);
}

function removePhones(value: string): string {
  return value.replace(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(\s*(ext|x)\.?\s*\d+)?/gi, "").trim();
}

function containsEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

function removeEmails(value: string): string {
  return value.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "").trim();
}

function isZip(value: string): boolean {
  return ZIP_PATTERN.test(value.trim());
}

function isSecondaryUnit(value: string): boolean {
  return SECONDARY_UNIT_PREFIXES.test(value.trim());
}

function looksLikeStreetAddress(value: string): boolean {
  return /\d/.test(value) && /[a-zA-Z]/.test(value) && !isZip(value) && !isPhone(value);
}

function looksLikePersonName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 3) return false;
  if (/\d/.test(trimmed)) return false;
  if (/\b(po\s*box|p\.?o\.?\s*box)\b/i.test(trimmed)) return false;
  if (isSecondaryUnit(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  const lastWord = words[words.length - 1].toLowerCase().replace(/\./g, "");
  const streetWords = [...Object.keys(STREET_ABBREVIATIONS), ...Object.values(STREET_ABBREVIATIONS).map(s => s.toLowerCase())];
  return !streetWords.includes(lastWord);
}

/** Title-case a string, preserving business acronyms */
function titleCase(value: string): string {
  if (!value.trim()) return value;
  let result = value.toLowerCase().replace(/(?:^|\s|[-/.])\S/g, (char) => char.toUpperCase());
  result = result.replace(PRESERVE_UPPER, (m) => m.toUpperCase());
  result = result.replace(/'\w/g, (m) => m.toUpperCase());
  return result;
}

function standardizeAbbreviations(value: string): string {
  let result = value;
  for (const [full, abbr] of Object.entries(STREET_ABBREVIATIONS)) {
    result = result.replace(new RegExp(`\\b${full}\\.?\\b`, "gi"), abbr);
  }
  result = result.replace(/\.\s*$/, "");
  result = result.replace(/\b([A-Z]{2})\.\s/g, "$1 ");
  return result;
}

/** Apply known city name corrections after title-casing. */
function correctCityName(city: string): string {
  const key = city.toLowerCase().trim();
  return CITY_CORRECTIONS[key] ?? city;
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

  // ── Remove "Usa" / "United States" / "Us" from end of fields ─
  city = city.replace(/,?\s*(usa|united\s*states|us)\s*$/i, "").trim();
  addr2 = addr2.replace(/,?\s*(usa|united\s*states|us)\s*$/i, "").trim();

  // ── Remove phone numbers from ALL fields ─────────────────────
  if (isPhone(addr1)) addr1 = "";
  if (isPhone(addr2)) addr2 = "";
  if (isPhone(city)) city = "";
  if (containsPhone(addr1)) addr1 = removePhones(addr1);
  if (containsPhone(addr2)) addr2 = removePhones(addr2);
  if (containsPhone(city)) city = removePhones(city);
  if (containsPhone(payeeName)) payeeName = removePhones(payeeName);

  // ── Remove email addresses from address fields ───────────────
  if (containsEmail(addr2)) addr2 = removeEmails(addr2);
  if (containsEmail(city)) city = removeEmails(city);
  if (containsEmail(addr1)) addr1 = removeEmails(addr1);

  // ── Fix spacing then rejoin ordinals ─────────────────────────
  if (addr1) addr1 = normalizeOrdinals(fixSpacing(addr1));
  if (addr2) addr2 = normalizeOrdinals(fixSpacing(addr2));
  if (city) city = normalizeOrdinals(fixSpacing(city));

  // ── Remove backticks, stray punctuation ──────────────────────
  addr1 = addr1.replace(/[`]/g, "").trim();
  addr2 = addr2.replace(/[`]/g, "").trim();

  // ── Resolve full state names: "Illinois" → "IL" ──────────────
  if (state) {
    const resolved = resolveStateName(state);
    if (resolved) {
      state = resolved;
    } else if (state.length > 2) {
      ambiguousReasons.push(`Invalid state '${state}'`);
      state = "";
    }
  }

  // ── Garbage in city field ─────────────────────────────────────
  if (city && /\b(payee|contact|email|address|phone|fax|account|invoice)\b/i.test(city)) {
    city = "";
  }

  // ── State+zip in city: "IL 62814", "IL. 60502" ──────────────
  if (city) {
    const stateZipMatch = city.match(/^([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)\s*$/);
    if (stateZipMatch) {
      const resolved = resolveStateName(stateZipMatch[1]);
      if (resolved) {
        if (!state) state = resolved;
        if (!zip) zip = stateZipMatch[2];
        city = "";
      }
    }
  }

  // ── Zip in city field ────────────────────────────────────────
  if (isZip(city)) {
    if (!zip) zip = city;
    city = "";
  }

  // ── "State Zip" or "StateName Zip" in city: "Illinois 62701" ─
  if (city) {
    const stateZipMatch2 = city.match(/^([A-Za-z.'\s]+?)\s+(\d{5}(?:-\d{4})?)\s*$/);
    if (stateZipMatch2) {
      const resolved = resolveStateName(stateZipMatch2[1]);
      if (resolved) {
        if (!state) state = resolved;
        if (!zip) zip = stateZipMatch2[2];
        city = "";
      }
    }
    // "Christopher, Illinois" in city field
    if (city) {
      const cityStateMatch = city.match(/^(.+?),?\s+(illinois|indiana|iowa|missouri|wisconsin|ohio|kentucky|michigan|tennessee|minnesota|georgia|virginia|texas|california|florida|new\s+york|pennsylvania|[a-z]{2,})\s*$/i);
      if (cityStateMatch) {
        const resolved = resolveStateName(cityStateMatch[2]);
        if (resolved) {
          city = clean(cityStateMatch[1]);
          if (!state) state = resolved;
        }
      }
    }
  }

  // ── Parse cityStateZip fallback ──────────────────────────────
  if (cityStateZipRaw && (!city || !state || !zip)) {
    const parsed = parseCityStateZip(cityStateZipRaw);
    if (parsed) {
      if (!city && parsed.city) city = parsed.city;
      if (!state && parsed.state) state = parsed.state;
      if (!zip && parsed.zip) zip = parsed.zip;
    }
  }

  // ── addr2 contains city/state/zip ────────────────────────────
  if (addr2 && !isSecondaryUnit(addr2)) {
    const parsed = parseCityStateZip(addr2);
    if (parsed && (parsed.city || parsed.state || parsed.zip)) {
      if (!city && parsed.city) city = parsed.city;
      if (!state && parsed.state) state = parsed.state;
      if (!zip && parsed.zip) zip = parsed.zip;
      addr2 = "";
    } else {
      if (city && addr2.toLowerCase().replace(/[.,]/g, "").trim() === city.toLowerCase().trim()) {
        addr2 = "";
      }
    }
  }

  // ── Entire address crammed into addr1 ────────────────────────
  if (addr1) {
    const extracted = extractTrailingCityStateZip(addr1);
    if (extracted) {
      addr1 = extracted.prefix;
      if (!city) city = extracted.city;
      if (!state) state = extracted.state;
      if (!zip) zip = extracted.zip;
    }
  }

  // ── addr1 is bare number, city has street suffix + city fused ─
  if (addr1 && city) {
    const noStreetSuffix = !/\b(St|Ave|Rd|Dr|Ln|Ct|Cir|Pl|Ter|Trl|Blvd|Hwy|Way|Pkwy)\b/i.test(addr1);
    if (/^\d/.test(addr1) && noStreetSuffix) {
      const sfx = "(?:St|Ave|Rd|Dr|Ln|Ct|Cir|Pl|Ter|Trl|Blvd|Hwy|Way|Pkwy|Street|Avenue|Road|Drive|Lane|Court|Circle|Place|Terrace|Trail|Boulevard|Highway|Parkway)";
      const splitRe = new RegExp(`^(.+?\\b${sfx})\\.?\\s+([A-Z][A-Za-z\\s'-]+)$`, "i");
      const splitMatch = city.match(splitRe);
      if (splitMatch) {
        addr1 = `${addr1} ${splitMatch[1].replace(/\.$/, "")}`;
        city = splitMatch[2].trim();
      } else {
        const justStreetRe = new RegExp(`^[A-Za-z0-9\\s.'-]+\\b${sfx}\\.?$`, "i");
        if (justStreetRe.test(city)) {
          addr1 = `${addr1} ${city.replace(/\.$/, "")}`;
          city = "";
        }
      }
    }
  }

  // ── addr1 has "City, State ZIP" but no street ────────────────
  if (addr1 && !looksLikeStreetAddress(addr1)) {
    const parsed = parseCityStateZip(addr1);
    if (parsed && (parsed.city || parsed.state)) {
      if (!city && parsed.city) city = parsed.city;
      if (!state && parsed.state) state = parsed.state;
      if (!zip && parsed.zip) zip = parsed.zip;
      addr1 = "";
    }
  }

  // ── Person name in addr1, real address in addr2 ──────────────
  if (addr1 && addr2 && looksLikePersonName(addr1) && looksLikeStreetAddress(addr2)) {
    addr1 = addr2;
    addr2 = "";
  }

  // ── payeeName duplicated in addr1 ────────────────────────────
  if (addr1 && payeeName && addr1.toLowerCase().replace(/[.,]/g, "").trim() === payeeName.toLowerCase().replace(/[.,]/g, "").trim()) {
    if (addr2 && looksLikeStreetAddress(addr2)) {
      addr1 = addr2;
      addr2 = "";
    } else {
      addr1 = "";
    }
  }

  // ── ATTN: prefix in addr1 ───────────────────────────────────
  if (/^attn:?\s*/i.test(addr1)) {
    if (addr2 && looksLikeStreetAddress(addr2)) {
      addr1 = addr2;
      addr2 = "";
    } else {
      addr1 = addr1.replace(/^attn:?\s*/i, "");
    }
  }

  // ── Duplicate addr1 ≈ addr2 ──────────────────────────────────
  if (addr1 && addr2) {
    const norm1 = addr1.toLowerCase().replace(/[.,\s]+/g, " ").trim();
    const norm2 = addr2.toLowerCase().replace(/[.,\s]+/g, " ").trim();
    if (norm1 === norm2) addr2 = "";
  }

  // ── Duplicate city in addr2 ──────────────────────────────────
  if (addr2 && city && addr2.toLowerCase().replace(/[.,]/g, "").trim() === city.toLowerCase().trim()) {
    addr2 = "";
  }

  // ── addr2 still has "City, ST ZIP" pattern ───────────────────
  if (addr2) {
    const extracted = extractTrailingCityStateZip(addr2);
    if (extracted) {
      addr2 = extracted.prefix;
      if (!city) city = extracted.city;
      if (!state) state = extracted.state;
      if (!zip) zip = extracted.zip;
    }
  }

  // ── "PO Box" normalization ───────────────────────────────────
  if (addr2 && /^po\s*box/i.test(addr2) && /^po\s*box/i.test(addr1)) {
    addr2 = "";
  }
  if (addr2 && /^(pobox|p\.?o\.?\s*box)\s/i.test(addr2) && !addr1) {
    addr1 = addr2;
    addr2 = "";
  }

  // ── Validate + normalize state ───────────────────────────────
  if (state) {
    const resolved = resolveStateName(state);
    if (resolved) {
      state = resolved;
    } else {
      state = state.toUpperCase();
      if (!US_STATES.has(state)) {
        ambiguousReasons.push(`Invalid state '${state}'`);
        state = "";
      }
    }
  }

  // ── Validate zip ─────────────────────────────────────────────
  if (zip) {
    const cleanedZip = zip.replace(/[^\d-]/g, "");
    if (ZIP_PATTERN.test(cleanedZip)) {
      zip = cleanedZip;
    } else {
      ambiguousReasons.push(`Invalid zip '${zip}'`);
      zip = "";
    }
  }

  // ── Zip-state validation ─────────────────────────────────────
  const correctedState = correctStateForZip(state || null, zip || null);
  if (correctedState) state = correctedState;

  // ── Casing ───────────────────────────────────────────────────
  if (payeeName) payeeName = titleCase(payeeName);
  if (addr1) addr1 = titleCase(standardizeAbbreviations(addr1));
  if (addr2) addr2 = titleCase(standardizeAbbreviations(addr2));
  if (city) city = correctCityName(titleCase(city));

  // ── Final cleanup: trailing dashes, commas, periods ──────────
  addr1 = addr1.replace(/[,.\s-]+$/, "").trim();
  addr2 = addr2.replace(/[,.\s-]+$/, "").trim();
  city = city.replace(/[,.\s-]+$/, "").trim();

  // ── Flag as ambiguous if critical data is still suspect ───────
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
