type SupplementTiming = "am" | "pm";
type SupplementDoseUnit =
  | "capsule"
  | "tablet"
  | "mg"
  | "mcg"
  | "g"
  | "ml"
  | "drop"
  | "scoop"
  | "other";

const SUPPLEMENT_DOSE_UNITS = new Set<SupplementDoseUnit>([
  "capsule",
  "tablet",
  "mg",
  "mcg",
  "g",
  "ml",
  "drop",
  "scoop",
  "other",
]);

const SUPPLEMENT_TIMINGS = new Set<SupplementTiming>(["am", "pm"]);

const CLAUDE_TIMEOUT_MS = 60_000;

type ClaudeCredentials = {
  apiKey: string;
  model: string;
};

type AnthropicMessageContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
    };

type PriceSourceProbe = {
  sourceName: string;
  sourceUrl: string;
  productUrl: string | null;
  observedPrices: number[];
};

type NormalizedPriceCandidate = PriceSourceProbe & {
  medianPrice: number | null;
};

export type SupplementImageExtractionResult = {
  name: string | null;
  brand: string | null;
  dose: string | null;
  doseUnit: SupplementDoseUnit;
  dosePerUnit: string | null;
  quantityPerBottle: number | null;
  timing: SupplementTiming | null;
  confidence: number | null;
  notes: string | null;
};

export type SupplementPriceCheckResult = {
  pricePerBottle: number | null;
  currency: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  confidence: number | null;
  notes: string | null;
  candidates: NormalizedPriceCandidate[];
};

type PriceSourceConfig = {
  sourceName: string;
  searchUrl: (query: string) => string;
};

const PRICE_SOURCES: PriceSourceConfig[] = [
  {
    sourceName: "Amazon",
    searchUrl: (query) => `https://www.amazon.com/s?k=${encodeURIComponent(query)}`,
  },
  {
    sourceName: "Nutricost",
    searchUrl: (query) => `https://nutricost.com/search?q=${encodeURIComponent(query)}`,
  },
  {
    sourceName: "Nootropics Depot",
    searchUrl: (query) =>
      `https://nootropicsdepot.com/search.php?search_query=${encodeURIComponent(query)}`,
  },
];

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toClampedConfidence(value: unknown): number | null {
  const parsed = toNullableNumber(value);
  if (parsed === null) return null;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeDoseUnit(value: unknown): SupplementDoseUnit {
  const raw = toNonEmptyString(value)?.toLowerCase();
  if (raw && SUPPLEMENT_DOSE_UNITS.has(raw as SupplementDoseUnit)) {
    return raw as SupplementDoseUnit;
  }
  return "capsule";
}

function normalizeTiming(value: unknown): SupplementTiming | null {
  const raw = toNonEmptyString(value)?.toLowerCase();
  if (raw && SUPPLEMENT_TIMINGS.has(raw as SupplementTiming)) {
    return raw as SupplementTiming;
  }
  return null;
}

function sanitizePrice(value: unknown): number | null {
  const parsed = toNullableNumber(value);
  if (parsed === null) return null;
  if (parsed <= 0 || parsed > 10_000) return null;
  return Number(parsed.toFixed(2));
}

function parseJsonFromClaudeText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const parsed = JSON.parse(candidate);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Record<string, unknown>;
}

function extractClaudeText(payload: unknown): string {
  const root =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const content = Array.isArray(root.content) ? root.content : [];
  const firstTextBlock = content.find(
    (block) =>
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
  ) as { text?: string } | undefined;

  return firstTextBlock?.text ?? "";
}

async function callClaudeMessage(options: {
  credentials: ClaudeCredentials;
  system: string;
  content: AnthropicMessageContentPart[];
  maxTokens?: number;
}): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.credentials.apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
    body: JSON.stringify({
      model: options.credentials.model,
      max_tokens: options.maxTokens ?? 2048,
      system: options.system,
      messages: [
        {
          role: "user",
          content: options.content,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    let message = "Claude API error";
    try {
      message = (JSON.parse(errorBody) as { error?: { message?: string } })?.error?.message ?? message;
    } catch {
      // fall through
    }
    throw new Error(`Claude API error (${response.status}): ${message}`);
  }

  const payload = (await response.json()) as unknown;
  return extractClaudeText(payload);
}

function normalizeSupplementToken(value: string | null | undefined): string {
  if (!value) return "";
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findExistingSupplementMatch<
  T extends {
    id: string;
    name: string;
    brand?: string | null;
  }
>(
  definitions: T[],
  name: string,
  brand?: string | null
): T | null {
  const nameToken = normalizeSupplementToken(name);
  const brandToken = normalizeSupplementToken(brand);

  const exact = definitions.find((definition) => {
    const definitionName = normalizeSupplementToken(definition.name);
    const definitionBrand = normalizeSupplementToken(definition.brand ?? null);
    if (!definitionName || !nameToken) return false;
    if (definitionName !== nameToken) return false;
    if (!brandToken) return true;
    return definitionBrand === brandToken;
  });
  if (exact) return exact;

  return (
    definitions.find(
      (definition) => normalizeSupplementToken(definition.name) === nameToken
    ) ?? null
  );
}

function buildSupplementSearchQuery(input: {
  name: string;
  brand: string | null;
  dosePerUnit: string | null;
}): string {
  const parts = [
    input.brand,
    input.name,
    input.dosePerUnit,
    "supplement",
  ].filter((value): value is string => Boolean(value && value.trim()));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function extractPriceCandidatesFromHtml(html: string): number[] {
  const matches = Array.from(
    html.matchAll(/\$\s*([0-9]{1,4}(?:\.[0-9]{2})?)/g)
  );
  const unique = new Set<number>();

  for (const match of matches) {
    const raw = match[1];
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) continue;
    if (parsed <= 1 || parsed > 500) continue;
    unique.add(Number(parsed.toFixed(2)));
    if (unique.size >= 8) break;
  }

  return Array.from(unique.values()).sort((a, b) => a - b);
}

function extractProductUrlFromHtml(html: string, sourceName: string): string | null {
  const urlMatches = Array.from(
    html.matchAll(/https?:\/\/[^\s"'<>]+/g)
  ).map((match) => match[0]);

  const candidates = new Set<string>(urlMatches);
  if (sourceName === "Amazon") {
    const dpMatch = html.match(/\/dp\/[A-Z0-9]{10}/i)?.[0];
    if (dpMatch) {
      candidates.add(`https://www.amazon.com${dpMatch}`);
    }
  }

  const filtered = Array.from(candidates).filter((url) => {
    const lower = url.toLowerCase();
    if (sourceName === "Amazon") {
      return lower.includes("amazon.com") && !lower.includes("/s?");
    }
    if (sourceName === "Nutricost") {
      return lower.includes("nutricost.com") && !lower.includes("/search?");
    }
    if (sourceName === "Nootropics Depot") {
      return lower.includes("nootropicsdepot.com") && !lower.includes("/search");
    }
    return false;
  });

  return filtered[0] ?? null;
}

function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2));
}

async function probeSourceForPrices(
  source: PriceSourceConfig,
  query: string
): Promise<PriceSourceProbe> {
  const sourceUrl = source.searchUrl(query);
  let html = "";

  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "coherence-app/supplement-price-checker",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) {
      html = await response.text();
    }
  } catch {
    // Ignore source failures so other sources can still provide prices.
  }

  return {
    sourceName: source.sourceName,
    sourceUrl,
    productUrl: html ? extractProductUrlFromHtml(html, source.sourceName) : null,
    observedPrices: html ? extractPriceCandidatesFromHtml(html) : [],
  };
}

function normalizePriceCandidates(candidates: PriceSourceProbe[]): NormalizedPriceCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    medianPrice: computeMedian(candidate.observedPrices),
  }));
}

function normalizePriceSourceUrl(value: string | null | undefined): string | null {
  const raw = toNonEmptyString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeCurrency(value: unknown): string | null {
  const raw = toNonEmptyString(value)?.toUpperCase();
  if (!raw) return null;
  if (!/^[A-Z]{3}$/.test(raw)) return null;
  return raw;
}

function normalizeExtractionRecord(
  raw: unknown
): SupplementImageExtractionResult | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Record<string, unknown>;
  const name = toNonEmptyString(parsed.name);
  if (!name) return null;
  return {
    name,
    brand: toNonEmptyString(parsed.brand),
    dose: toNonEmptyString(parsed.dose),
    doseUnit: normalizeDoseUnit(parsed.doseUnit),
    dosePerUnit: toNonEmptyString(parsed.dosePerUnit),
    quantityPerBottle: toNullableNumber(parsed.quantityPerBottle),
    timing: normalizeTiming(parsed.timing),
    confidence: toClampedConfidence(parsed.confidence),
    notes: toNonEmptyString(parsed.notes),
  };
}

/**
 * Extract one or more supplements from a single image. A photo may
 * contain a group of bottles on a shelf, a pill organizer with
 * multiple products, or a single front-label shot — Claude returns
 * an entry per distinct supplement it can read.
 *
 * Returns an empty array if the image is legible but no supplement
 * labels are found; callers are responsible for surfacing that.
 */
export async function extractSupplementsFromBottleImage(options: {
  credentials: ClaudeCredentials;
  base64Image: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}): Promise<SupplementImageExtractionResult[]> {
  const systemPrompt = [
    "You read supplement bottle labels from images.",
    "An image may contain one OR many supplement bottles / packages.",
    "Return JSON only. No markdown. No prose.",
    "Schema:",
    "{",
    '  "supplements": [',
    "    {",
    '      "name": string|null,',
    '      "brand": string|null,',
    '      "dose": string|null,',
    '      "doseUnit": "capsule"|"tablet"|"mg"|"mcg"|"g"|"ml"|"drop"|"scoop"|"other",',
    '      "dosePerUnit": string|null,',
    '      "quantityPerBottle": number|null,',
    '      "timing": "am"|"pm"|null,',
    '      "confidence": number|null,',
    '      "notes": string|null',
    "    }",
    "  ]",
    "}",
    "Rules:",
    "- Return one array entry per distinct supplement product visible.",
    "- If a single image shows the same bottle twice (e.g. front + back",
    "  label of one product), emit ONE entry, not two.",
    "- If unreadable, set uncertain fields on that entry to null.",
    "- Omit an entry entirely only if you cannot read its supplement name.",
    "- quantityPerBottle should be numeric count if visible (e.g., 60).",
    "- confidence must be 0..1.",
    "- If the image contains zero readable supplements, return",
    '  {"supplements": []}.',
  ].join("\n");

  const userText =
    "Extract every supplement visible in this image using the schema exactly.";

  const responseText = await callClaudeMessage({
    credentials: options.credentials,
    system: systemPrompt,
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: options.mimeType,
          data: options.base64Image,
        },
      },
      {
        type: "text",
        text: userText,
      },
    ],
    maxTokens: 4096,
  });

  const parsed = parseJsonFromClaudeText(responseText);
  const rawList = Array.isArray(parsed.supplements)
    ? parsed.supplements
    : // Defensive fallback: Claude occasionally returns a bare object if
      // there is exactly one supplement. Treat that as a 1-item array so
      // downstream code has a consistent shape.
      parsed.name
      ? [parsed]
      : [];

  const results: SupplementImageExtractionResult[] = [];
  for (const raw of rawList) {
    const normalized = normalizeExtractionRecord(raw);
    if (normalized) results.push(normalized);
  }
  return results;
}

export async function checkSupplementPrice(options: {
  credentials: ClaudeCredentials;
  supplementName: string;
  brand: string | null;
  dosePerUnit: string | null;
}): Promise<SupplementPriceCheckResult> {
  const query = buildSupplementSearchQuery({
    name: options.supplementName,
    brand: options.brand,
    dosePerUnit: options.dosePerUnit,
  });

  const sourceSnapshots = await Promise.all(
    PRICE_SOURCES.map((source) => probeSourceForPrices(source, query))
  );
  const normalizedCandidates = normalizePriceCandidates(sourceSnapshots);

  const usableCandidates = normalizedCandidates.filter(
    (candidate) => candidate.observedPrices.length > 0
  );
  if (usableCandidates.length === 0) {
    return {
      pricePerBottle: null,
      currency: null,
      sourceName: null,
      sourceUrl: null,
      confidence: null,
      notes: "No price data found from configured sources.",
      candidates: normalizedCandidates,
    };
  }

  const systemPrompt = [
    "You pick the best current supplement price from candidate source data.",
    "Return JSON only. No markdown or extra text.",
    "Schema:",
    "{",
    '  "pricePerBottle": number|null,',
    '  "currency": "USD"|null,',
    '  "sourceName": string|null,',
    '  "sourceUrl": string|null,',
    '  "confidence": number|null,',
    '  "notes": string|null',
    "}",
    "Rules:",
    "- Choose from provided candidates only.",
    "- sourceName must exactly match one candidate sourceName or be null.",
    "- sourceUrl must be one of provided sourceUrl/productUrl values or null.",
    "- If uncertain, return null price/source with brief notes.",
    "- confidence must be between 0 and 1.",
  ].join("\n");

  const responseText = await callClaudeMessage({
    credentials: options.credentials,
    system: systemPrompt,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            supplement: {
              name: options.supplementName,
              brand: options.brand,
              dosePerUnit: options.dosePerUnit,
            },
            candidates: usableCandidates.map((candidate) => ({
              sourceName: candidate.sourceName,
              sourceUrl: candidate.sourceUrl,
              productUrl: candidate.productUrl,
              observedPrices: candidate.observedPrices,
              medianPrice: candidate.medianPrice,
            })),
          },
          null,
          2
        ),
      },
    ],
    maxTokens: 1200,
  });

  const parsed = parseJsonFromClaudeText(responseText);
  const pickedSourceName = toNonEmptyString(parsed.sourceName);
  const chosenCandidate =
    usableCandidates.find((candidate) => candidate.sourceName === pickedSourceName) ?? null;

  const candidateUrls = chosenCandidate
    ? new Set<string>(
        [chosenCandidate.productUrl, chosenCandidate.sourceUrl]
          .filter((value): value is string => Boolean(value))
      )
    : new Set<string>();
  const requestedSourceUrl = normalizePriceSourceUrl(
    toNonEmptyString(parsed.sourceUrl)
  );
  const normalizedSourceUrl =
    requestedSourceUrl && candidateUrls.has(requestedSourceUrl)
      ? requestedSourceUrl
      : chosenCandidate?.productUrl ?? chosenCandidate?.sourceUrl ?? null;

  const normalizedPrice = sanitizePrice(parsed.pricePerBottle);
  const currency = normalizeCurrency(parsed.currency) ?? (normalizedPrice !== null ? "USD" : null);
  const confidence = toClampedConfidence(parsed.confidence);

  return {
    pricePerBottle: normalizedPrice,
    currency,
    sourceName: chosenCandidate?.sourceName ?? null,
    sourceUrl: normalizedSourceUrl,
    confidence,
    notes: toNonEmptyString(parsed.notes),
    candidates: normalizedCandidates,
  };
}

export function sourceDomainFromUrl(url: string | null | undefined): string | null {
  const normalized = normalizePriceSourceUrl(url);
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return null;
  }
}

