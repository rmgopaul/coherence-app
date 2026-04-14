const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

const ADDRESS_CLEANING_SYSTEM_PROMPT = [
  "You clean US mailing address records. Return valid JSON: {\"rows\":[...]}. No prose.",
  "",
  "RULES:",
  "1. Return EXACTLY the same number of rows, in the SAME order, with the SAME keys.",
  "2. payeeName: Title-case. Preserve LLC/Inc/Corp.",
  "3. mailingAddress1: street address ONLY. Never a name, phone, city, or state.",
  "4. mailingAddress2: ONLY secondary unit (Apt/Ste/Unit/PO Box). Empty string if none.",
  "5. city: city name ONLY. Never zip, phone, state abbreviation, 'IL', or 'USA'. If city is 'IL 62814' or similar (state+zip), set city to empty string.",
  "6. state: 2-letter uppercase. Do NOT default to 'IL' — mailing may be any US state.",
  "7. zip: 5-digit or ZIP+4 ONLY.",
  "8. Standardize: Street→St, Avenue→Ave, Road→Rd, Drive→Dr, Lane→Ln, Court→Ct.",
  "9. Fix field-placement errors (city/state/zip in addr2, names in addr1, crammed addresses).",
  "10. Remove phone numbers, placeholders (N/A, TBD), duplicate fields.",
  "11. Use cityStateZip as fallback when city/state/zip are empty.",
  "12. Do NOT invent data. Empty string if uncertain.",
  "",
  "COMMON ERROR PATTERNS — you MUST fix these:",
  "13. SPLIT ORDINALS: Source data often splits ordinal suffixes. '55 Th'→'55th', '145 Th'→'145th', '92 Nd'→'92nd', '3 Rd'→'3rd', '1 St'→'1st' (when ordinal, not Street/Road). '16 Th St'→'16th St', '120 Th Av'→'120th Av'.",
  "14. NUMBER-ONLY ADDRESS + STREET-IN-CITY: When mailingAddress1 is ONLY a number (e.g. '4009') and city contains a street name fused with the city (e.g. 'Navaho Circle Pinckneyville'), split them: addr1='4009 Navaho Cir', city='Pinckneyville'. Examples: '301'+'N Grant St Oblong'→addr1='301 N Grant St', city='Oblong'. '337'+'Slingerland Drive Schaumburg'→addr1='337 Slingerland Dr', city='Schaumburg'. '1638'+'G Road Prairie Du Rocher'→addr1='1638 G Rd', city='Prairie Du Rocher'.",
  "15. STATE+ZIP IN CITY: When city is 'IL 62814', 'IL. 60502', 'IL 62549', etc. (a state abbreviation + zip), extract state and zip, set city to EMPTY STRING. The real city name is unknown — do not guess.",
  "16. CRAMMED ADDRESS: When mailingAddress1 contains the full address including city/state (e.g. '1034 145th Ave Joy IL' or '1805 N Main Georgetown Il'), split: addr1='1034 145th Ave', city='Joy', state='IL'.",
  "17. GARBAGE IN CITY: Values like 'Payee Contact Email Address:', email addresses, column headers, or phone numbers in city are data errors. Set city to empty string.",
  "18. ZIP-STATE VALIDATION: Illinois zips are 60000–62999. If zip is in that range but state is wrong (e.g. state='LA' with zip='60012'), correct state to 'IL'. Apply similar logic for other states.",
  "19. CITY CONTAINS CITY+STATE+ZIP: Parse 'Jacksonville Il, 62650'→city='Jacksonville', state='IL', zip='62650'. Also: 'Hillsboro, Il. 62049'→city='Hillsboro', state='IL', zip='62049'. 'Marion Il, 62959'→city='Marion', state='IL', zip='62959'.",
  "20. CITY MISSPELLINGS: Fix obvious misspellings — 'Hillsde'→'Hillside', 'Ofallon'→\"O'Fallon\", 'Milledgville'→'Milledgeville', 'Lagrange Park'→'La Grange Park'. Preserve proper capitalization: 'Dekalb'→'DeKalb', 'Mchenry'→'McHenry'.",
].join("\n");

const ADDRESS_QA_SYSTEM_PROMPT = [
  "You are a QA reviewer for US mailing address data. Return valid JSON: {\"rows\":[...]}. No prose.",
  "",
  "You are reviewing address records that have ALREADY been cleaned once. Your job is to catch remaining errors.",
  "Return EXACTLY the same number of rows, in the SAME order, with the SAME keys.",
  "",
  "FIX THESE COMMON REMAINING ERRORS:",
  "1. SPLIT ORDINALS still present: '55 Th Pl'→'55th Pl', '120 Th Ave'→'120th Ave', '92 Nd Ave'→'92nd Ave', '800 Th St'→'800th St'.",
  "2. STREET NAME FUSED IN CITY: If mailingAddress1 is just a house number (e.g. '301') and city looks like 'N Grant St Oblong', move the street portion to addr1: addr1='301 N Grant St', city='Oblong'.",
  "3. STATE+ZIP STILL IN CITY: 'IL 62814' or 'IL. 60502' in city → extract to state/zip, city=''.",
  "4. CITY MISSPELLINGS: 'Hillsde'→'Hillside', 'Ofallon'→\"O'Fallon\", 'Dekalb'→'DeKalb', 'Mchenry'→'McHenry', 'Lagrange Park'→'La Grange Park', 'Milledgville'→'Milledgeville'.",
  "5. MISSING CITY: If city is empty but you can infer it from the zip code with high confidence, fill it in.",
  "6. WRONG STATE for ZIP: Illinois zips 60000-62999 → state must be 'IL'. Missouri zips 63000-65999 → 'MO'. Correct mismatches.",
  "7. GARBAGE DATA: Remove column headers, email labels, 'Payee Contact Email Address:', phone numbers, or other non-address data from any field.",
  "8. ADDR2 SHOULD BE EMPTY: If mailingAddress2 contains a city name, state, zip, or non-unit text, clear it and move data to correct fields.",
  "9. Do NOT invent data. Empty string if uncertain.",
  "10. Standardize: Street→St, Avenue→Ave, Road→Rd, Drive→Dr, Lane→Ln, Court→Ct.",
].join("\n");

type LlmInputRow = {
  key: string;
  payeeName: string | null;
  mailingAddress1: string | null;
  mailingAddress2: string | null;
  cityStateZip: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

type LlmOutputRow = {
  key: string;
  payeeName: string | null;
  mailingAddress1: string | null;
  mailingAddress2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

async function callLlmRaw(
  provider: "anthropic" | "openai",
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
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
        system: systemPrompt,
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
    return data?.content?.[0]?.text ?? "";
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
          { role: "system", content: systemPrompt },
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
    return data?.choices?.[0]?.message?.content ?? "";
  }
}

function parseLlmResponse(content: string): LlmOutputRow[] {
  if (!content) throw new Error("LLM returned empty response.");

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

/**
 * Two-pass LLM address cleaning:
 * Pass 1 — Clean raw address data (uses ADDRESS_CLEANING_SYSTEM_PROMPT)
 * Pass 2 — QA review of Pass 1 results (uses ADDRESS_QA_SYSTEM_PROMPT)
 */
export async function callLlmForAddressCleaning(
  provider: "anthropic" | "openai",
  apiKey: string,
  model: string,
  rows: LlmInputRow[],
): Promise<LlmOutputRow[]> {
  // ── Pass 1: Clean ──────────────────────────────────────────────
  const pass1Content = await callLlmRaw(
    provider,
    apiKey,
    model,
    ADDRESS_CLEANING_SYSTEM_PROMPT,
    JSON.stringify({
      instructions: `Clean these ${rows.length} address records. Return EXACTLY ${rows.length} rows.`,
      rows,
    }),
  );
  const pass1Rows = parseLlmResponse(pass1Content);

  console.log(`[AI Cleaning] Pass 1 complete: ${pass1Rows.length} rows returned.`);

  // ── Pass 2: QA review ──────────────────────────────────────────
  // Feed Pass 1 output back for a second review with the QA prompt
  try {
    const pass2Input = pass1Rows.map((r) => ({
      key: r.key,
      payeeName: r.payeeName,
      mailingAddress1: r.mailingAddress1,
      mailingAddress2: r.mailingAddress2,
      city: r.city,
      state: r.state,
      zip: r.zip,
    }));

    const pass2Content = await callLlmRaw(
      provider,
      apiKey,
      model,
      ADDRESS_QA_SYSTEM_PROMPT,
      JSON.stringify({
        instructions: `QA-review these ${pass2Input.length} pre-cleaned address records. Fix any remaining errors. Return EXACTLY ${pass2Input.length} rows.`,
        rows: pass2Input,
      }),
    );
    const pass2Rows = parseLlmResponse(pass2Content);

    console.log(`[AI Cleaning] Pass 2 (QA) complete: ${pass2Rows.length} rows returned.`);

    // Use Pass 2 if it returned the right count, else fall back to Pass 1
    if (pass2Rows.length === rows.length) {
      return pass2Rows;
    }
    console.warn(`[AI Cleaning] Pass 2 returned ${pass2Rows.length} rows (expected ${rows.length}). Using Pass 1 results.`);
    return pass1Rows;
  } catch (pass2Error) {
    console.error(`[AI Cleaning] Pass 2 (QA) failed: ${pass2Error instanceof Error ? pass2Error.message : "Unknown error"}. Using Pass 1 results.`);
    return pass1Rows;
  }
}

export function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeMailingText(value: unknown): string | null {
  const raw = toNonEmptyString(value);
  if (!raw) return null;
  const normalized = raw
    .replace(/\u00a0/g, " ")
    .replace(/[''`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeMailingCompareToken(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

export function normalizeStateAbbreviation(value: string | null | undefined): string | null {
  const raw = normalizeMailingText(value);
  if (!raw) return null;

  const letters = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (!letters) return null;
  if (letters.length === 2) return letters;

  const fullStateMap: Record<string, string> = {
    ALABAMA: "AL",
    ALASKA: "AK",
    ARIZONA: "AZ",
    ARKANSAS: "AR",
    CALIFORNIA: "CA",
    COLORADO: "CO",
    CONNECTICUT: "CT",
    DELAWARE: "DE",
    FLORIDA: "FL",
    GEORGIA: "GA",
    HAWAII: "HI",
    IDAHO: "ID",
    ILLINOIS: "IL",
    INDIANA: "IN",
    IOWA: "IA",
    KANSAS: "KS",
    KENTUCKY: "KY",
    LOUISIANA: "LA",
    MAINE: "ME",
    MARYLAND: "MD",
    MASSACHUSETTS: "MA",
    MICHIGAN: "MI",
    MINNESOTA: "MN",
    MISSISSIPPI: "MS",
    MISSOURI: "MO",
    MONTANA: "MT",
    NEBRASKA: "NE",
    NEVADA: "NV",
    NEWHAMPSHIRE: "NH",
    NEWJERSEY: "NJ",
    NEWMEXICO: "NM",
    NEWYORK: "NY",
    NORTHCAROLINA: "NC",
    NORTHDAKOTA: "ND",
    OHIO: "OH",
    OKLAHOMA: "OK",
    OREGON: "OR",
    PENNSYLVANIA: "PA",
    RHODEISLAND: "RI",
    SOUTHCAROLINA: "SC",
    SOUTHDAKOTA: "SD",
    TENNESSEE: "TN",
    TEXAS: "TX",
    UTAH: "UT",
    VERMONT: "VT",
    VIRGINIA: "VA",
    WASHINGTON: "WA",
    WESTVIRGINIA: "WV",
    WISCONSIN: "WI",
    WYOMING: "WY",
  };

  return fullStateMap[letters] ?? letters.slice(0, 2);
}

export function normalizeZipCode(value: string | null | undefined): string | null {
  const raw = normalizeMailingText(value);
  if (!raw) return null;
  const match = raw.match(/\d{5}(?:-\d{4})?/);
  return match ? match[0] : null;
}

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
  const match = normalized.match(/^(.+?)(?:,\s*|\s+)([A-Za-z]{2,})(?:[\s,.\-]+(\d{5}(?:-\d{4})?))?$/);
  if (!match) return { city: null, state: null, zip: null };

  return {
    city: normalizeMailingText(match[1]?.replace(/[.,]+$/g, "")),
    state: normalizeStateAbbreviation(match[2]),
    zip: normalizeZipCode(match[3] ?? null),
  };
}

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

  const parsedFromCityStateZip = parseCityStateZip(input.cityStateZip ?? null);
  if (!city && parsedFromCityStateZip.city) city = parsedFromCityStateZip.city;
  if (!state && parsedFromCityStateZip.state) state = parsedFromCityStateZip.state;
  if (!zip && parsedFromCityStateZip.zip) zip = parsedFromCityStateZip.zip;

  if (mailingAddress2 && looksLikePhoneNumber(mailingAddress2)) {
    mailingAddress2 = null;
  }

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

  if (mailingAddress2) {
    const mailingAddress2Token = normalizeMailingCompareToken(mailingAddress2);
    const mailingAddress1Token = normalizeMailingCompareToken(mailingAddress1);
    const payeeToken = normalizeMailingCompareToken(payeeName);
    const cityStateZipToken = normalizeMailingCompareToken(
      [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    );

    if (
      !mailingAddress2Token ||
      mailingAddress2Token === mailingAddress1Token ||
      mailingAddress2Token === payeeToken ||
      (cityStateZipToken.length > 0 && mailingAddress2Token === cityStateZipToken)
    ) {
      mailingAddress2 = null;
    }
  }

  if (!mailingAddress1 && mailingAddress2) {
    const parsedFromAddress2 = parseCityStateZip(mailingAddress2);
    const hasParsedLocation = Boolean(parsedFromAddress2.city || parsedFromAddress2.state || parsedFromAddress2.zip);
    if (!hasParsedLocation && !looksLikePhoneNumber(mailingAddress2)) {
      mailingAddress1 = mailingAddress2;
      mailingAddress2 = null;
    }
  }

  // ── Final guard: addr2 must be a recognized secondary line ──
  // Bare city names, state names, or other stray text is never valid in addr2.
  if (mailingAddress2 && !looksLikeSecondaryAddressLine(mailingAddress2)) {
    // If it looks like a bare city name (alphabetic, no digits), use as city fallback
    if (!city && /^[A-Za-z\s.'-]+$/.test(mailingAddress2)) {
      city = mailingAddress2;
    }
    mailingAddress2 = null;
  }

  city = city ? city.replace(/[.,]+$/g, "").trim() : null;
  state = normalizeStateAbbreviation(state);
  zip = normalizeZipCode(zip);

  return {
    payeeName,
    mailingAddress1,
    mailingAddress2,
    city,
    state,
    zip,
  };
}
