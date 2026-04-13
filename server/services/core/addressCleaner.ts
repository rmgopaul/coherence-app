/**
 * Deterministic US mailing address cleaner.
 *
 * Handles: casing, abbreviations, field-placement errors, state/zip validation,
 * phone number removal, email removal, placeholder values, cityStateZip parsing,
 * stuck-together numbers+words, "Illinois"→"IL" expansion, duplicate fields.
 *
 * Returns `{ cleaned, ambiguousRows }` — ambiguous rows should be sent to LLM.
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

const STATE_FULL_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
  // Common abbreviations
  "ill": "IL", "ill.": "IL", "i'll": "IL",
  "ind": "IN", "ind.": "IN",
  "wis": "WI", "wis.": "WI",
  "mich": "MI", "mich.": "MI",
  "minn": "MN", "minn.": "MN",
  "calif": "CA", "calif.": "CA",
};

const PRESERVE_UPPER = /\b(LLC|INC|CORP|LTD|LP|LLP|PC|PA|DBA|CUPHD|HM2|NA|NV|II|III|IV|PO|RR|US|SE|NE|NW|SW)\b/gi;

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

function isValidState(value: string): boolean {
  return US_STATES.has(value.trim().toUpperCase());
}

function resolveStateName(value: string): string | null {
  const lower = value.trim().toLowerCase().replace(/\.$/, "");
  if (STATE_FULL_NAMES[lower]) return STATE_FULL_NAMES[lower];
  const upper = value.trim().toUpperCase();
  if (US_STATES.has(upper)) return upper;
  return null;
}

function isSecondaryUnit(value: string): boolean {
  return SECONDARY_UNIT_PREFIXES.test(value.trim());
}

/** Fix stuck-together number+word patterns: "17Saratoga" → "17 Saratoga" */
function fixSpacing(value: string): string {
  // "123MainSt" → "123 Main St" (digit followed by uppercase letter)
  let result = value.replace(/(\d)([A-Z])/g, "$1 $2");
  // "Main123" → handled naturally, but "1315Wabash" → "1315 Wabash"
  result = result.replace(/(\d)([a-z])/g, (_, d, l) => `${d} ${l.toUpperCase()}`);
  return result;
}

/**
 * Rejoin split ordinal suffixes: "55 Th" → "55th", "92 Nd" → "92nd".
 * fixSpacing() can create these from "55TH" → "55 TH", so this must run after.
 * Only handles unambiguous suffixes (Th, Nd). Rd/St are ambiguous with Road/Street.
 */
function normalizeOrdinals(value: string): string {
  // "55 Th" → "55th", "145 Th" → "145th" — Th is always ordinal after a number
  let result = value.replace(/(\d+)\s+[Tt][Hh]\b/g, "$1th");
  // "92 Nd" → "92nd", "2 Nd" → "2nd" — Nd is always ordinal after a number
  result = result.replace(/(\d+)\s+[Nn][Dd]\b/g, "$1nd");
  return result;
}

function looksLikeStreetAddress(value: string): boolean {
  // Has digits + text = probably a street address
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
  // Restore preserved acronyms
  result = result.replace(PRESERVE_UPPER, (m) => m.toUpperCase());
  // Fix "O'Brien" etc
  result = result.replace(/'\w/g, (m) => m.toUpperCase());
  return result;
}

function standardizeAbbreviations(value: string): string {
  let result = value;
  for (const [full, abbr] of Object.entries(STREET_ABBREVIATIONS)) {
    result = result.replace(new RegExp(`\\b${full}\\.?\\b`, "gi"), abbr);
  }
  // Remove trailing periods from abbreviations
  result = result.replace(/\.\s*$/, "");
  // Clean stray periods after abbreviations: "IL." → "IL"
  result = result.replace(/\b([A-Z]{2})\.\s/g, "$1 ");
  return result;
}

/**
 * Parse city/state/zip from a string like "Springfield, IL 62701" or
 * "Springfield, Illinois 62701" or "Springfield IL. 62701"
 */
function parseCityStateZip(value: string): { city: string; state: string; zip: string } | null {
  const trimmed = clean(value);
  if (!trimmed) return null;

  // Remove "USA", "United States", "Us" suffix
  const cleaned = trimmed.replace(/,?\s*(usa|united\s*states|us)\s*$/i, "").trim();

  // Pattern: "City, STATE_NAME ZIP" or "City STATE_ABBR ZIP" or "City, IL. ZIP"
  const patterns = [
    // "City, IL 62701" or "City, IL.62701"
    /^(.+?),?\s+([A-Za-z]{2,})\.?\s*(\d{5}(?:-\d{4})?)\s*$/,
    // "City, IL" (no zip)
    /^(.+?),\s+([A-Za-z]{2,})\s*$/,
    // Just "City IL" (no comma, 2-letter state)
    /^(.+?)\s+([A-Za-z]{2})\s*$/,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) {
      const possibleState = resolveStateName(match[2]);
      if (possibleState) {
        return {
          city: clean(match[1]).replace(/,\s*$/, ""),
          state: possibleState,
          zip: match[3] || "",
        };
      }
    }
  }

  // Just a zip
  const zipMatch = cleaned.match(/^(\d{5}(?:-\d{4})?)$/);
  if (zipMatch) return { city: "", state: "", zip: zipMatch[1] };

  return null;
}

/**
 * Try to extract city, state, zip from the end of a string like
 * "408 W High St. Roanoke, IL. 61561" → { prefix: "408 W High St", city: "Roanoke", state: "IL", zip: "61561" }
 */
function extractTrailingCityStateZip(value: string): { prefix: string; city: string; state: string; zip: string } | null {
  const trimmed = clean(value);

  // "... City, ST 12345" or "... City, Illinois 12345" or "... City Il 12345"
  const patterns = [
    /^(.+?)[.,]\s+([A-Za-z\s]+?)[.,]?\s+([A-Za-z]{2,})\.?\s+(\d{5}(?:-\d{4})?)\s*$/,
    /^(.+?)\s+([A-Za-z\s]+?),?\s+([A-Za-z]{2,})\.?\s*(\d{5}(?:-\d{4})?)\s*$/,
    // "... City STATE ZIP" all at end with comma before city
    /^(.+?),\s*([A-Za-z\s]+?)\s+([A-Za-z]{2,})\.?\s*(\d{5}(?:-\d{4})?)\s*$/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) {
      const possibleState = resolveStateName(match[3]);
      if (possibleState && match[1].length > 3) {
        return {
          prefix: clean(match[1]).replace(/[.,]\s*$/, ""),
          city: clean(match[2]),
          state: possibleState,
          zip: match[4],
        };
      }
    }
  }

  // Simpler: "... City, ST" (no zip, comma required)
  const simpleMatch = trimmed.match(/^(.+?),\s*([A-Za-z\s]+?),?\s+([A-Za-z]{2,})\.?\s*$/);
  if (simpleMatch) {
    const possibleState = resolveStateName(simpleMatch[3]);
    if (possibleState && simpleMatch[1].length > 3) {
      return { prefix: clean(simpleMatch[1]).replace(/[.,]\s*$/, ""), city: clean(simpleMatch[2]), state: possibleState, zip: "" };
    }
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

  // ── Fix spacing: "17Saratoga" → "17 Saratoga" ───────────────
  if (addr1) addr1 = fixSpacing(addr1);
  if (addr2) addr2 = fixSpacing(addr2);
  if (city) city = fixSpacing(city);

  // ── Rejoin split ordinals: "55 Th" → "55th" ────────────────
  if (addr1) addr1 = normalizeOrdinals(addr1);
  if (addr2) addr2 = normalizeOrdinals(addr2);
  if (city) city = normalizeOrdinals(city);

  // ── Remove backticks, stray punctuation ──────────────────────
  addr1 = addr1.replace(/[`]/g, "").trim();
  addr2 = addr2.replace(/[`]/g, "").trim();

  // ── Resolve full state names: "Illinois" → "IL" ──────────────
  if (state) {
    const resolved = resolveStateName(state);
    if (resolved) {
      state = resolved;
    } else if (state.length > 2) {
      // Invalid state like "GERMANY", "DR", etc.
      ambiguousReasons.push(`Invalid state '${state}'`);
      state = "";
    }
  }

  // ── Garbage in city field ─────────────────────────────────────
  // Column headers, email labels, or other non-city text
  if (city && /\b(payee|contact|email|address|phone|fax|account|invoice)\b/i.test(city)) {
    city = "";
  }

  // ── Zip in city field ────────────────────────────────────────
  if (isZip(city)) {
    if (!zip) zip = city;
    city = "";
  }

  // ── State+zip in city: "IL 62701" or "Illinois 62701" ────────
  if (city) {
    const stateZipMatch = city.match(/^([A-Za-z.'\s]+?)\s+(\d{5}(?:-\d{4})?)\s*$/);
    if (stateZipMatch) {
      const resolved = resolveStateName(stateZipMatch[1]);
      if (resolved) {
        if (!state) state = resolved;
        if (!zip) zip = stateZipMatch[2];
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
      // Check if addr2 is just a city name that matches the city field
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
  // e.g. addr1="4009", city="Navaho Circle Pinckneyville"
  //   → addr1="4009 Navaho Circle", city="Pinckneyville"
  if (addr1 && city) {
    const noStreetSuffix = !/\b(St|Ave|Rd|Dr|Ln|Ct|Cir|Pl|Ter|Trl|Blvd|Hwy|Way|Pkwy)\b/i.test(addr1);
    if (/^\d/.test(addr1) && noStreetSuffix) {
      const sfx = "(?:St|Ave|Rd|Dr|Ln|Ct|Cir|Pl|Ter|Trl|Blvd|Hwy|Way|Pkwy|Street|Avenue|Road|Drive|Lane|Court|Circle|Place|Terrace|Trail|Boulevard|Highway|Parkway)";
      // "Navaho Circle Pinckneyville" → streetPart + cityName
      const splitRe = new RegExp(`^(.+?\\b${sfx})\\.?\\s+([A-Z][A-Za-z\\s'-]+)$`, "i");
      const splitMatch = city.match(splitRe);
      if (splitMatch) {
        addr1 = `${addr1} ${splitMatch[1].replace(/\.$/, "")}`;
        city = splitMatch[2].trim();
      } else {
        // City is ONLY a street name with no city after: "Shellbark Ct"
        const justStreetRe = new RegExp(`^[A-Za-z0-9\\s.'-]+\\b${sfx}\\.?$`, "i");
        if (justStreetRe.test(city)) {
          addr1 = `${addr1} ${city.replace(/\.$/, "")}`;
          city = "";
        }
      }
    }
  }

  // ── addr1 has "City, State ZIP" but no street (entire field is city/state/zip) ─
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

  // ── addr2 still has "City, ST ZIP" pattern after earlier checks ─
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
    // Both are PO Box — deduplicate
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

  // ── Casing ───────────────────────────────────────────────────
  if (payeeName) payeeName = titleCase(payeeName);
  if (addr1) addr1 = titleCase(standardizeAbbreviations(addr1));
  if (addr2) addr2 = titleCase(standardizeAbbreviations(addr2));
  if (city) city = titleCase(city);

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
