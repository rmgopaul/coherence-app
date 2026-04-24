/**
 * politicalOdds — Polymarket implied probabilities for the three
 * 2026 midterm questions Rhett tracks on the front page:
 *   HOUSE   — P(Democrats win the House)
 *   SENATE  — P(Democrats win the Senate)
 *   SWEEP   — P(Democrats win both chambers)
 *
 * Data comes from Polymarket's public gamma API (no key, no auth).
 * We resolve each event by slug, then pick the Democratic outcome
 * out of the event's markets. Polymarket's multi-party events are
 * typically split into one binary (Yes/No) market per party under a
 * single event — so for HOUSE / SENATE we look for the market whose
 * `groupItemTitle` names Democrats and read its Yes price. For the
 * balance-of-power event we look for the market whose title
 * describes Democrats winning both chambers.
 *
 * Mirrors the shape and caching ergonomics of `approvalRatings.ts`:
 * curl-fallback for sandboxed fetch environments, stale-on-failure
 * cache per label, per-source error strings surfaced to the UI.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type PoliticalOddsLabel = "HOUSE" | "SENATE" | "SWEEP";

export interface PoliticalOddsItem {
  label: PoliticalOddsLabel;
  demPercent: number | null;
  asOf: string | null;
  url: string;
  error?: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const execFileAsync = promisify(execFile);
const CURL_STATUS_MARKER = "__HTTP_STATUS__:";

const POLYMARKET_GAMMA_BASE = "https://gamma-api.polymarket.com";
const POLYMARKET_WEB_BASE = "https://polymarket.com/event";

const HOUSE_EVENT_SLUG = "which-party-will-win-the-house-in-2026";
const SENATE_EVENT_SLUG = "which-party-will-win-the-senate-in-2026";
const SWEEP_EVENT_SLUG = "balance-of-power-2026-midterms";

interface GammaMarket {
  id?: string;
  question?: string;
  slug?: string;
  outcomes?: string;
  outcomePrices?: string;
  lastTradePrice?: number | string | null;
  endDate?: string | null;
  updatedAt?: string | null;
  groupItemTitle?: string | null;
  closed?: boolean;
}

interface GammaEvent {
  id?: string;
  slug?: string;
  title?: string;
  markets?: GammaMarket[];
  updatedAt?: string | null;
}

async function fetchJsonViaCurl<T>(url: string): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync(
      "curl",
      [
        "-L",
        "-sS",
        "--max-time",
        "8",
        "-A",
        USER_AGENT,
        "-H",
        "Accept: application/json",
        "-w",
        `\n${CURL_STATUS_MARKER}%{http_code}`,
        url,
      ],
      { timeout: 10_000, maxBuffer: 3_000_000 }
    );

    const markerIdx = stdout.lastIndexOf(CURL_STATUS_MARKER);
    if (markerIdx < 0) return null;

    const text = stdout.slice(0, markerIdx).trim();
    const statusText = stdout.slice(markerIdx + CURL_STATUS_MARKER.length).trim();
    const status = Number.parseInt(statusText, 10);
    if (!Number.isFinite(status) || status < 200 || status >= 300) return null;

    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (response.ok) {
      return (await response.json()) as T;
    }
  } catch {
    // fall through to curl
  }
  return fetchJsonViaCurl<T>(url);
}

function parseJsonArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : null;
  } catch {
    return null;
  }
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isDemocratLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return (
    normalized === "democratic" ||
    normalized === "democrat" ||
    normalized === "democrats" ||
    normalized === "dem" ||
    normalized === "dems" ||
    normalized === "d"
  );
}

function yesPriceFromMarket(market: GammaMarket): number | null {
  const outcomes = parseJsonArray(market.outcomes);
  const prices = parseJsonArray(market.outcomePrices);
  if (outcomes && prices && outcomes.length === prices.length) {
    const yesIdx = outcomes.findIndex(
      (o) => o.trim().toLowerCase() === "yes"
    );
    if (yesIdx >= 0) {
      const pct = toFiniteNumber(prices[yesIdx]);
      if (pct !== null) return pct;
    }
  }
  // Fallback: binary markets where lastTradePrice is the Yes price
  // already (0-1). Used if `outcomePrices` is missing on the shape.
  const last = toFiniteNumber(market.lastTradePrice);
  if (last !== null && last >= 0 && last <= 1) return last;
  return null;
}

/**
 * Party event ("Which party will win X?"): find the market whose
 * groupItemTitle/question names the Democrats, and return its Yes
 * price. Handles both cases Polymarket has shipped for these
 * events (one-binary-per-party and single-multi-outcome).
 */
function extractDemFromPartyEvent(event: GammaEvent): {
  demPercent: number | null;
  asOf: string | null;
} {
  const markets = (event.markets ?? []).filter((m) => !m.closed);

  // Case A — one binary market per party (the common shape today).
  for (const m of markets) {
    const title = (m.groupItemTitle ?? m.question ?? "").trim();
    if (!title) continue;
    if (!isDemocratLabel(title) && !/\bdemocrat/i.test(title)) continue;
    const price = yesPriceFromMarket(m);
    if (price !== null) {
      return { demPercent: price * 100, asOf: m.updatedAt ?? event.updatedAt ?? null };
    }
  }

  // Case B — single market with outcomes ["Democratic","Republican"].
  if (markets.length === 1) {
    const m = markets[0];
    const outcomes = parseJsonArray(m.outcomes);
    const prices = parseJsonArray(m.outcomePrices);
    if (outcomes && prices && outcomes.length === prices.length) {
      const idx = outcomes.findIndex(isDemocratLabel);
      if (idx >= 0) {
        const pct = toFiniteNumber(prices[idx]);
        if (pct !== null) {
          return { demPercent: pct * 100, asOf: m.updatedAt ?? event.updatedAt ?? null };
        }
      }
    }
  }

  return { demPercent: null, asOf: null };
}

/**
 * Balance-of-power event: four outcomes (Dem sweep, GOP sweep, and
 * two split cases). Pick the market that mentions Democrats winning
 * BOTH chambers — "Dem trifecta", "Democrats win both", "Democrats
 * sweep", etc.
 */
function extractDemSweepFromBalanceEvent(event: GammaEvent): {
  demPercent: number | null;
  asOf: string | null;
} {
  const markets = (event.markets ?? []).filter((m) => !m.closed);
  for (const m of markets) {
    const title = (m.groupItemTitle ?? m.question ?? "").toLowerCase();
    if (!title) continue;
    const mentionsDem = /\bdem(ocrat(s|ic)?)?\b/.test(title);
    const mentionsBoth =
      /\bboth\b|\bsweep\b|\btrifecta\b|\bwin.*house.*senate\b|\bcontrol.*house.*senate\b/.test(
        title
      );
    if (!mentionsDem || !mentionsBoth) continue;
    const price = yesPriceFromMarket(m);
    if (price !== null) {
      return { demPercent: price * 100, asOf: m.updatedAt ?? event.updatedAt ?? null };
    }
  }
  return { demPercent: null, asOf: null };
}

async function fetchEventBySlug(slug: string): Promise<GammaEvent | null> {
  const url = `${POLYMARKET_GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`;
  const result = await fetchJson<GammaEvent[] | GammaEvent>(url);
  if (!result) return null;
  if (Array.isArray(result)) return result[0] ?? null;
  return result;
}

interface SourceConfig {
  label: PoliticalOddsLabel;
  slug: string;
  extract: (event: GammaEvent) => { demPercent: number | null; asOf: string | null };
}

const SOURCES: SourceConfig[] = [
  { label: "HOUSE", slug: HOUSE_EVENT_SLUG, extract: extractDemFromPartyEvent },
  { label: "SENATE", slug: SENATE_EVENT_SLUG, extract: extractDemFromPartyEvent },
  { label: "SWEEP", slug: SWEEP_EVENT_SLUG, extract: extractDemSweepFromBalanceEvent },
];

async function fetchSingleOdds(cfg: SourceConfig): Promise<PoliticalOddsItem> {
  const url = `${POLYMARKET_WEB_BASE}/${cfg.slug}`;
  try {
    const event = await fetchEventBySlug(cfg.slug);
    if (!event) throw new Error("Event not found on Polymarket.");
    const { demPercent, asOf } = cfg.extract(event);
    if (demPercent === null) {
      throw new Error("Democratic outcome not resolved from event markets.");
    }
    return { label: cfg.label, demPercent, asOf, url };
  } catch (error) {
    return {
      label: cfg.label,
      demPercent: null,
      asOf: null,
      url,
      error:
        error instanceof Error ? error.message : "Unable to fetch odds.",
    };
  }
}

// Prediction markets don't move fast enough to justify the dashboard's
// 5-minute cadence. Cache per-label for 15 min, and independently keep
// a last-known-good copy so a transient gamma 5xx serves the prior
// value instead of an error row in the UI.
const FRESH_TTL_MS = 15 * 60_000;
const lastGoodByLabel = new Map<
  PoliticalOddsLabel,
  { at: number; value: PoliticalOddsItem }
>();

function withStaleFallback(
  label: PoliticalOddsLabel,
  fresh: PoliticalOddsItem
): PoliticalOddsItem {
  if (fresh.demPercent !== null) {
    lastGoodByLabel.set(label, { at: Date.now(), value: fresh });
    return fresh;
  }
  const cached = lastGoodByLabel.get(label);
  if (cached) return cached.value;
  return fresh;
}

export async function fetchPoliticalOdds(): Promise<PoliticalOddsItem[]> {
  const now = Date.now();
  return Promise.all(
    SOURCES.map(async (cfg) => {
      const cached = lastGoodByLabel.get(cfg.label);
      if (cached && now - cached.at < FRESH_TTL_MS) return cached.value;
      const fresh = await fetchSingleOdds(cfg);
      return withStaleFallback(cfg.label, fresh);
    })
  );
}

export function __getPoliticalOddsCacheSnapshot(): Record<
  string,
  { at: number; value: PoliticalOddsItem }
> {
  return Object.fromEntries(lastGoodByLabel.entries());
}
