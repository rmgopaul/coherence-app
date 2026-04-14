/**
 * Address cleaning utilities — the single source of truth for:
 *  - Text normalization (ordinals, spacing, state abbreviations, zip codes)
 *  - City/state/zip parsing
 *  - LLM-based address cleaning (single focused pass)
 *  - Post-LLM sanitization safety net
 */

/* ------------------------------------------------------------------ */
/*  Shared constants                                                    */
/* ------------------------------------------------------------------ */

const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "AS", "MP",
]);

/** Lowercase key → 2-letter state code. Includes full names + common abbreviations. */
const STATE_NAME_MAP: Record<string, string> = {
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
  // Common abbreviations found in CSG data
  ill: "IL", "ill.": "IL", ind: "IN", "ind.": "IN",
  wis: "WI", "wis.": "WI", mich: "MI", "mich.": "MI",
  minn: "MN", "minn.": "MN", calif: "CA", "calif.": "CA",
};

/**
 * Zip prefix → expected state. Used to detect mismatches like PA+60xxx.
 * Only includes ranges where the mapping is unambiguous.
 */
const ZIP_PREFIX_TO_STATE: Record<string, string> = {
  "600": "IL", "601": "IL", "602": "IL", "603": "IL", "604": "IL",
  "605": "IL", "606": "IL", "607": "IL", "608": "IL", "609": "IL",
  "610": "IL", "611": "IL", "612": "IL", "613": "IL", "614": "IL",
  "615": "IL", "616": "IL", "617": "IL", "618": "IL", "619": "IL",
  "620": "IL", "621": "IL", "622": "IL", "623": "IL", "624": "IL",
  "625": "IL", "626": "IL", "627": "IL", "628": "IL", "629": "IL",
  "630": "MO", "631": "MO", "632": "MO", "633": "MO", "634": "MO",
  "635": "MO", "636": "MO", "637": "MO", "638": "MO", "639": "MO",
  "640": "MO", "641": "MO", "644": "MO", "645": "MO", "646": "MO",
  "647": "MO", "648": "MO", "649": "MO", "650": "MO", "651": "MO",
  "652": "MO", "653": "MO", "654": "MO", "655": "MO", "656": "MO",
  "657": "MO", "658": "MO", "659": "MO",
};

/* ------------------------------------------------------------------ */
/*  Primitive helpers                                                   */
/* ------------------------------------------------------------------ */

export function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeMailingText(value: unknown): string | null {
  const raw = toNonEmptyString(value);
  if (!raw) return null;
  const normalized = raw
    .replace(/\u00a0/g, " ")
    .replace(/['\u2018\u2019`\u00b4]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeMailingCompareToken(value: string | null | undefined): string {
  if (!value) return "";
  return value.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

/* ------------------------------------------------------------------ */
/*  State / zip / ordinals                                              */
/* ------------------------------------------------------------------ */

/**
 * Resolve a state value to a 2-letter abbreviation.
 * Handles: "IL", "Illinois", "Ill", "Ill.", 2-letter codes, full names.
 */
export function resolveStateName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Fast path: already 2-letter
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && US_STATES.has(upper)) return upper;

  // Lookup by lowercase (handles full names + abbreviations like "ill", "calif")
  const lower = trimmed.toLowerCase().replace(/\.$/, "");
  if (STATE_NAME_MAP[lower]) return STATE_NAME_MAP[lower];

  // Fallback: strip non-alpha, check if it's a known state
  const letters = upper.replace(/[^A-Z]/g, "");
  if (letters.length === 2 && US_STATES.has(letters)) return letters;

  return null;
}

export function normalizeStateAbbreviation(value: string | null | undefined): string | null {
  const raw = normalizeMailingText(value);
  if (!raw) return null;
  return resolveStateName(raw);
}

export function normalizeZipCode(value: string | null | undefined): string | null {
  const raw = normalizeMailingText(value);
  if (!raw) return null;
  const match = raw.match(/\d{5}(?:-\d{4})?/);
  return match ? match[0] : null;
}

/**
 * Correct state when zip clearly belongs to a different state.
 * e.g. state="PA", zip="61111" → state="IL"
 */
export function correctStateForZip(state: string | null, zip: string | null): string | null {
  if (!zip || !state) return state;
  const prefix = zip.slice(0, 3);
  const expectedState = ZIP_PREFIX_TO_STATE[prefix];
  if (expectedState && expectedState !== state) {
    return expectedState;
  }
  return state;
}

/** Rejoin split ordinal suffixes: "55 Th" → "55th", "92 Nd" → "92nd". */
export function normalizeOrdinals(value: string): string {
  let result = value.replace(/(\d+)\s+[Tt][Hh]\b/g, "$1th");
  result = result.replace(/(\d+)\s+[Nn][Dd]\b/g, "$1nd");
  return result;
}

/** Fix stuck-together number+word patterns: "17Saratoga" → "17 Saratoga" */
export function fixSpacing(value: string): string {
  let result = value.replace(/(\d)([A-Z])/g, "$1 $2");
  result = result.replace(/(\d)([a-z])/g, (_, d, l) => `${d} ${l.toUpperCase()}`);
  return result;
}

/* ------------------------------------------------------------------ */
/*  City/state/zip parsing                                              */
/* ------------------------------------------------------------------ */

/**
 * Parse "City, ST 62701" or "City, Illinois 62701" or "62701" etc.
 * Returns null values (not empty strings) when fields are missing.
 */
export function parseCityStateZip(value: string | null | undefined): {
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const raw = normalizeMailingText(value);
  if (!raw) return { city: null, state: null, zip: null };

  const normalized = raw
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();

  // "City, IL 62701" or "City IL.62701" etc.
  const patterns = [
    /^(.+?),?\s+([A-Za-z]{2,})\.?\s*(\d{5}(?:-\d{4})?)\s*$/,
    /^(.+?),\s+([A-Za-z]{2,})\s*$/,
    /^(.+?)\s+([A-Za-z]{2})\s*$/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      const possibleState = resolveStateName(match[2]);
      if (possibleState) {
        return {
          city: normalizeMailingText(match[1]?.replace(/[.,]+$/g, "")),
          state: possibleState,
          zip: normalizeZipCode(match[3] ?? null),
        };
      }
    }
  }

  // Just a bare zip
  const zipMatch = normalized.match(/^(\d{5}(?:-\d{4})?)$/);
  if (zipMatch) return { city: null, state: null, zip: zipMatch[1] };

  return { city: null, state: null, zip: null };
}

/**
 * Extract trailing city/state/zip from a crammed address string.
 * "408 W High St. Roanoke, IL. 61561" → { prefix: "408 W High St", city: "Roanoke", state: "IL", zip: "61561" }
 */
export function extractTrailingCityStateZip(value: string): {
  prefix: string; city: string; state: string; zip: string;
} | null {
  const trimmed = normalizeMailingText(value);
  if (!trimmed) return null;

  const patterns = [
    /^(.+?)[.,]\s+([A-Za-z\s]+?)[.,]?\s+([A-Za-z]{2,})\.?\s+(\d{5}(?:-\d{4})?)\s*$/,
    /^(.+?)\s+([A-Za-z\s]+?),?\s+([A-Za-z]{2,})\.?\s*(\d{5}(?:-\d{4})?)\s*$/,
    /^(.+?),\s*([A-Za-z\s]+?)\s+([A-Za-z]{2,})\.?\s*(\d{5}(?:-\d{4})?)\s*$/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) {
      const possibleState = resolveStateName(match[3]);
      if (possibleState && match[1].length > 3) {
        return {
          prefix: (normalizeMailingText(match[1]) ?? "").replace(/[.,]\s*$/, ""),
          city: normalizeMailingText(match[2]) ?? "",
          state: possibleState,
          zip: match[4],
        };
      }
    }
  }

  // "... City, ST" (no zip)
  const simpleMatch = trimmed.match(/^(.+?),\s*([A-Za-z\s]+?),?\s+([A-Za-z]{2,})\.?\s*$/);
  if (simpleMatch) {
    const possibleState = resolveStateName(simpleMatch[3]);
    if (possibleState && simpleMatch[1].length > 3) {
      return {
        prefix: (normalizeMailingText(simpleMatch[1]) ?? "").replace(/[.,]\s*$/, ""),
        city: normalizeMailingText(simpleMatch[2]) ?? "",
        state: possibleState,
        zip: "",
      };
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Detection helpers                                                   */
/* ------------------------------------------------------------------ */

export function looksLikePhoneNumber(value: string | null | undefined): boolean {
  const raw = normalizeMailingText(value);
  if (!raw) return false;
  return /\b(?:\+?1[-.\s]*)?(?:\(?\d{3}\)?[-.\s]*)\d{3}[-.\s]*\d{4}\b/.test(raw);
}

export function looksLikeSecondaryAddressLine(value: string | null | undefined): boolean {
  const raw = normalizeMailingText(value);
  if (!raw) return false;
  return /\b(?:apt|apartment|unit|suite|ste|fl|floor|bldg|building|dept|lot|trlr|trailer|po\s*box|p\.?\s*o\.?\s*box|attn|attention|c\/o|care\s+of|pmb|box)\b/i.test(raw) || /#\s*[A-Za-z0-9-]+/.test(raw);
}

/* ------------------------------------------------------------------ */
/*  sanitizeMailingFields — the post-LLM safety net                     */
/* ------------------------------------------------------------------ */

export function sanitizeMailingFields(input: {
  payeeName: string | null;
  mailingAddress1: string | null;
  mailingAddress2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  cityStateZip?: string | null;
}): {
  payeeName: string | null;
  mailingAddress1: string | null;
  mailingAddress2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  let payeeName = normalizeMailingText(input.payeeName);
  let mailingAddress1 = normalizeMailingText(input.mailingAddress1);
  let mailingAddress2 = normalizeMailingText(input.mailingAddress2);
  let city = normalizeMailingText(input.city);
  let state = normalizeStateAbbreviation(input.state);
  let zip = normalizeZipCode(input.zip);

  // ── Ordinal normalization ───────────────────────────────────────
  if (mailingAddress1) mailingAddress1 = normalizeOrdinals(mailingAddress1);
  if (mailingAddress2) mailingAddress2 = normalizeOrdinals(mailingAddress2);

  // ── cityStateZip fallback ───────────────────────────────────────
  const parsedFromCityStateZip = parseCityStateZip(input.cityStateZip ?? null);
  if (!city && parsedFromCityStateZip.city) city = parsedFromCityStateZip.city;
  if (!state && parsedFromCityStateZip.state) state = parsedFromCityStateZip.state;
  if (!zip && parsedFromCityStateZip.zip) zip = parsedFromCityStateZip.zip;

  // ── Garbage in city ─────────────────────────────────────────────
  if (city && /\b(payee|contact|email|address|phone|fax|account|invoice)\b/i.test(city)) {
    city = null;
  }

  // ── State+zip stuck in city: "IL 62814", "IL. 60502" ────────────
  if (city) {
    const stateZipInCity = city.match(/^([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)\s*$/);
    if (stateZipInCity) {
      const resolved = resolveStateName(stateZipInCity[1]);
      if (resolved) {
        if (!state) state = resolved;
        if (!zip) zip = stateZipInCity[2];
        city = null;
      }
    }
  }

  // ── City contains "City, St. Zip" ───────────────────────────────
  if (city) {
    const parsed = parseCityStateZip(city);
    if (parsed.city && parsed.state) {
      city = parsed.city;
      if (!state) state = parsed.state;
      if (!zip && parsed.zip) zip = parsed.zip;
    }
  }

  // ── Phone in addr2 ──────────────────────────────────────────────
  if (mailingAddress2 && looksLikePhoneNumber(mailingAddress2)) {
    mailingAddress2 = null;
  }

  // ── addr2 contains city/state/zip ───────────────────────────────
  if (mailingAddress2) {
    const parsedFromAddress2 = parseCityStateZip(mailingAddress2);
    const hasParsedLocation = Boolean(parsedFromAddress2.city || parsedFromAddress2.state || parsedFromAddress2.zip);
    if (hasParsedLocation) {
      if (!city && parsedFromAddress2.city) city = parsedFromAddress2.city;
      if (!state && parsedFromAddress2.state) state = parsedFromAddress2.state;
      if (!zip && parsedFromAddress2.zip) zip = parsedFromAddress2.zip;
      if (!looksLikeSecondaryAddressLine(mailingAddress2)) {
        mailingAddress2 = null;
      }
    }
  }

  // ── addr1 is pure city/state/zip (no street number) ─────────────
  if (mailingAddress1) {
    const parsedFromAddress1 = parseCityStateZip(mailingAddress1);
    const hasParsedLocation = Boolean(parsedFromAddress1.city || parsedFromAddress1.state || parsedFromAddress1.zip);
    const hasStreetNumber = /\d/.test(mailingAddress1);
    if (hasParsedLocation && !hasStreetNumber && !looksLikeSecondaryAddressLine(mailingAddress1)) {
      if (!city && parsedFromAddress1.city) city = parsedFromAddress1.city;
      if (!state && parsedFromAddress1.state) state = parsedFromAddress1.state;
      if (!zip && parsedFromAddress1.zip) zip = parsedFromAddress1.zip;
      mailingAddress1 = null;
    }
  }

  // ── Deduplicate addr2 vs addr1 / payeeName / city ───────────────
  if (mailingAddress2) {
    const addr2Token = normalizeMailingCompareToken(mailingAddress2);
    const addr1Token = normalizeMailingCompareToken(mailingAddress1);
    const payeeToken = normalizeMailingCompareToken(payeeName);
    const cszToken = normalizeMailingCompareToken(
      [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    );

    if (
      !addr2Token ||
      addr2Token === addr1Token ||
      addr2Token === payeeToken ||
      (cszToken.length > 0 && addr2Token === cszToken)
    ) {
      mailingAddress2 = null;
    }
  }

  // ── Promote addr2 to addr1 if addr1 is empty ────────────────────
  if (!mailingAddress1 && mailingAddress2) {
    const parsedFromAddress2 = parseCityStateZip(mailingAddress2);
    const hasParsedLocation = Boolean(parsedFromAddress2.city || parsedFromAddress2.state || parsedFromAddress2.zip);
    if (!hasParsedLocation && !looksLikePhoneNumber(mailingAddress2)) {
      mailingAddress1 = mailingAddress2;
      mailingAddress2 = null;
    }
  }

  // ── Final guard: addr2 must be a recognized secondary line ──────
  if (mailingAddress2 && !looksLikeSecondaryAddressLine(mailingAddress2)) {
    if (!city && /^[A-Za-z\s.'-]+$/.test(mailingAddress2)) {
      city = mailingAddress2;
    }
    mailingAddress2 = null;
  }

  // ── Final normalization ─────────────────────────────────────────
  city = city ? city.replace(/[.,]+$/g, "").trim() : null;
  state = normalizeStateAbbreviation(state);
  zip = normalizeZipCode(zip);

  // ── Zip-state validation (must run last) ────────────────────────
  state = correctStateForZip(state, zip);

  return { payeeName, mailingAddress1, mailingAddress2, city, state, zip };
}

/* ------------------------------------------------------------------ */
/*  LLM cleaning                                                        */
/* ------------------------------------------------------------------ */

const ADDRESS_CLEANING_SYSTEM_PROMPT = [
  "You clean US mailing address records. Return valid JSON: {\"rows\":[...]}. No prose.",
  "",
  "RULES:",
  "1. Return EXACTLY the same number of rows, in the SAME order, with the SAME keys.",
  "2. payeeName: Title-case. Preserve LLC/Inc/Corp.",
  "3. mailingAddress1: street address ONLY. Never a name, phone, city, or state.",
  "4. mailingAddress2: ONLY secondary unit (Apt/Ste/Unit/PO Box). Empty string if none.",
  "5. city: city name ONLY. Never zip, phone, state abbreviation, or 'USA'. If city is 'IL 62814' or similar, set city to empty string.",
  "6. state: 2-letter uppercase abbreviation.",
  "7. zip: 5-digit or ZIP+4 ONLY.",
  "8. Standardize: Street→St, Avenue→Ave, Road→Rd, Drive→Dr, Lane→Ln, Court→Ct.",
  "9. Fix field-placement errors (city/state/zip in wrong field, crammed addresses).",
  "10. Remove phone numbers, placeholders (N/A, TBD), duplicate fields.",
  "11. Use cityStateZip as fallback when city/state/zip are empty.",
  "12. Do NOT invent data. Empty string if uncertain.",
  "",
  "CRITICAL PATTERNS TO FIX:",
  "13. CRAMMED ADDRESS: '1034 145th Ave Joy IL' → addr1='1034 145th Ave', city='Joy', state='IL'.",
  "14. NUMBER-ONLY ADDRESS + STREET-IN-CITY: addr1='301', city='N Grant St Oblong' → addr1='301 N Grant St', city='Oblong'.",
  "15. MISSING CITY: If city is empty but you can infer it from zip with high confidence, fill it in.",
  "16. CITY MISSPELLINGS: Fix obvious errors — 'Hillsde'→'Hillside', 'Ofallon'→\"O'Fallon\", 'Milledgville'→'Milledgeville'. Capitalization: 'Dekalb'→'DeKalb', 'Mchenry'→'McHenry'.",
].join("\n");

export async function callLlmForAddressCleaning(
  provider: "anthropic" | "openai",
  apiKey: string,
  model: string,
  rows: Array<{
    key: string;
    payeeName: string | null;
    mailingAddress1: string | null;
    mailingAddress2: string | null;
    cityStateZip: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  }>,
): Promise<Array<{
  key: string;
  payeeName: string | null;
  mailingAddress1: string | null;
  mailingAddress2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}>> {
  const userContent = JSON.stringify({
    instructions: `Clean these ${rows.length} address records. Return EXACTLY ${rows.length} rows.`,
    rows,
  });

  let content: string;

  if (provider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model,
        max_tokens: 16384,
        system: ADDRESS_CLEANING_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      let message = "Anthropic API error";
      try { message = (JSON.parse(errorBody) as any)?.error?.message || message; } catch {}
      throw new Error(`Anthropic API error (${response.status}): ${message}`);
    }

    const data = await response.json() as any;
    content = data?.content?.[0]?.text ?? "";
  } else {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ADDRESS_CLEANING_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      let message = "OpenAI API error";
      try { message = (JSON.parse(errorBody) as any)?.error?.message || message; } catch {}
      throw new Error(`OpenAI API error (${response.status}): ${message}`);
    }

    const data = await response.json() as any;
    content = data?.choices?.[0]?.message?.content ?? "";
  }

  if (!content) throw new Error("LLM returned empty response.");

  // Extract JSON from potential markdown code fences
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();

  const parsed = JSON.parse(jsonStr) as { rows?: unknown };
  if (!Array.isArray(parsed?.rows)) {
    throw new Error("LLM response missing 'rows' array.");
  }

  return (parsed.rows as Array<Record<string, unknown>>).map((row) => ({
    key: String(row.key ?? ""),
    payeeName: toNonEmptyString(row.payeeName),
    mailingAddress1: toNonEmptyString(row.mailingAddress1),
    mailingAddress2: toNonEmptyString(row.mailingAddress2),
    city: toNonEmptyString(row.city),
    state: toNonEmptyString(row.state),
    zip: toNonEmptyString(row.zip),
  }));
}
