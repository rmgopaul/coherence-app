import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ApprovalRatingSource {
  source: "RCP" | "NYT";
  approve: number | null;
  disapprove: number | null;
  net: number | null;
  asOf: string | null;
  url: string;
  error?: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const execFileAsync = promisify(execFile);
const CURL_STATUS_MARKER = "__HTTP_STATUS__:";

const RCP_APPROVAL_URL =
  "https://www.realclearpolling.com/polls/approval/donald-trump/approval-rating";
const NYT_APPROVAL_CSV_URL =
  "https://www.nytimes.com/newsgraphics/polls/approval/president-averages.csv";

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

async function fetchTextViaCurl(url: string, accept: string): Promise<{ status: number; text: string } | null> {
  try {
    const { stdout } = await execFileAsync(
      "curl",
      [
        "-L",
        "-sS",
        "--max-time",
        "12",
        "-A",
        USER_AGENT,
        "-H",
        `Accept: ${accept}`,
        "-w",
        `\n${CURL_STATUS_MARKER}%{http_code}`,
        url,
      ],
      { timeout: 15_000, maxBuffer: 3_000_000 }
    );

    const markerIdx = stdout.lastIndexOf(CURL_STATUS_MARKER);
    if (markerIdx < 0) return null;

    const text = stdout.slice(0, markerIdx).trim();
    const statusText = stdout.slice(markerIdx + CURL_STATUS_MARKER.length).trim();
    const status = Number.parseInt(statusText, 10);
    if (!Number.isFinite(status) || status <= 0) return null;

    return { status, text };
  } catch {
    return null;
  }
}

async function fetchText(url: string, accept: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: accept,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      return await response.text();
    }
  } catch {
    // use curl fallback below
  }

  const curlFallback = await fetchTextViaCurl(url, accept);
  if (curlFallback && curlFallback.status >= 200 && curlFallback.status < 300) {
    return curlFallback.text;
  }

  throw new Error("Request failed for approval rating source.");
}

function decodeNextFlightPayload(html: string): string {
  const scriptRegex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;
  let match: RegExpExecArray | null;
  let decoded = "";

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      decoded += JSON.parse(`"${match[1]}"`);
    } catch {
      // ignore malformed segment
    }
  }
  return decoded;
}

function parseRcpAverageFromText(text: string): {
  approve: number;
  disapprove: number;
  asOf: string | null;
} | null {
  const avgBlockMatch = text.match(
    /"type":"rcp_average"[\s\S]*?"date":"([^"]+)"[\s\S]*?"candidate":\[(.*?)\],"undecided"/
  );
  if (!avgBlockMatch) return null;

  const asOf = avgBlockMatch[1] ?? null;
  const candidateBlock = avgBlockMatch[2] ?? "";
  const approveMatch = candidateBlock.match(/"name":"Approve"[^}]*"value":"([^"]+)"/);
  const disapproveMatch = candidateBlock.match(/"name":"Disapprove"[^}]*"value":"([^"]+)"/);

  const approve = toFiniteNumber(approveMatch?.[1]);
  const disapprove = toFiniteNumber(disapproveMatch?.[1]);
  if (approve === null || disapprove === null) return null;

  return { approve, disapprove, asOf };
}

async function fetchRcpTrumpApproval(): Promise<ApprovalRatingSource> {
  try {
    const html = await fetchText(RCP_APPROVAL_URL, "text/html");
    let parsed = parseRcpAverageFromText(html);
    if (!parsed) {
      const decoded = decodeNextFlightPayload(html);
      parsed = parseRcpAverageFromText(decoded);
    }
    if (!parsed) throw new Error("RCP average block not found.");

    return {
      source: "RCP",
      approve: parsed.approve,
      disapprove: parsed.disapprove,
      net: parsed.approve - parsed.disapprove,
      asOf: parsed.asOf,
      url: RCP_APPROVAL_URL,
    };
  } catch (error) {
    return {
      source: "RCP",
      approve: null,
      disapprove: null,
      net: null,
      asOf: null,
      url: RCP_APPROVAL_URL,
      error: error instanceof Error ? error.message : "Unable to fetch RCP approval average.",
    };
  }
}

async function fetchNytTrumpApproval(): Promise<ApprovalRatingSource> {
  try {
    const csvText = await fetchText(NYT_APPROVAL_CSV_URL, "text/csv,text/plain,*/*");
    const lines = csvText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) {
      throw new Error("NYT approval CSV is empty.");
    }

    const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const topicIdx = header.indexOf("topic");
    const dateIdx = header.indexOf("date");
    const answerIdx = header.indexOf("answer");
    const pctIdx = header.indexOf("pct");
    if (topicIdx < 0 || dateIdx < 0 || answerIdx < 0 || pctIdx < 0) {
      throw new Error("NYT approval CSV headers are missing.");
    }

    const byDate = new Map<string, { approve?: number; disapprove?: number }>();
    for (const line of lines.slice(1)) {
      const cells = splitCsvLine(line);
      const topic = (cells[topicIdx] ?? "").trim();
      const date = (cells[dateIdx] ?? "").trim();
      const answer = (cells[answerIdx] ?? "").trim().toLowerCase();
      const pct = toFiniteNumber(cells[pctIdx]);
      if (!topic || !date || pct === null) continue;
      if (!/approval\s*-\s*trump/i.test(topic)) continue;

      const bucket = byDate.get(date) ?? {};
      if (answer === "approve") bucket.approve = pct;
      if (answer === "disapprove") bucket.disapprove = pct;
      byDate.set(date, bucket);
    }

    const dates = Array.from(byDate.keys()).sort();
    if (dates.length === 0) {
      throw new Error("No NYT Trump approval rows found.");
    }

    const asOf = dates[dates.length - 1];
    const latest = byDate.get(asOf) ?? {};
    const approve = toFiniteNumber(latest.approve);
    const disapprove = toFiniteNumber(latest.disapprove);
    if (approve === null || disapprove === null) {
      throw new Error("NYT latest approve/disapprove values are incomplete.");
    }

    return {
      source: "NYT",
      approve,
      disapprove,
      net: approve - disapprove,
      asOf,
      url: NYT_APPROVAL_CSV_URL,
    };
  } catch (error) {
    return {
      source: "NYT",
      approve: null,
      disapprove: null,
      net: null,
      asOf: null,
      url: NYT_APPROVAL_CSV_URL,
      error: error instanceof Error ? error.message : "Unable to fetch NYT approval average.",
    };
  }
}

/**
 * Approval averages update once per day; polling every 5 minutes (the
 * dashboard cadence) wastes requests and makes us more likely to trip
 * DataDome / Cloudflare rate limits on RCP. Cache successful responses
 * per source for up to 60 minutes, and independently keep a
 * "last-known-good" copy indefinitely so a transient scraper failure
 * (e.g. DataDome challenge page) falls back to the previous value
 * instead of surfacing an error row in the UI.
 */
const FRESH_TTL_MS = 60 * 60_000;
const lastGoodBySource = new Map<string, { at: number; value: ApprovalRatingSource }>();

function withStaleFallback(
  key: "RCP" | "NYT",
  fresh: ApprovalRatingSource
): ApprovalRatingSource {
  const isFresh =
    fresh.approve !== null && fresh.disapprove !== null && fresh.net !== null;
  if (isFresh) {
    lastGoodBySource.set(key, { at: Date.now(), value: fresh });
    return fresh;
  }
  const cached = lastGoodBySource.get(key);
  if (cached) {
    // Serve the last-good value untouched. The `asOf` stamp already
    // tells the UI how current the data actually is, so callers can
    // still tell a stale value from a fresh one without a separate
    // "stale" flag on the response shape.
    return cached.value;
  }
  return fresh;
}

export async function fetchTrumpApprovalRatings(): Promise<ApprovalRatingSource[]> {
  const now = Date.now();
  const rcpCached = lastGoodBySource.get("RCP");
  const nytCached = lastGoodBySource.get("NYT");

  const needsRcp = !rcpCached || now - rcpCached.at >= FRESH_TTL_MS;
  const needsNyt = !nytCached || now - nytCached.at >= FRESH_TTL_MS;

  const [rcpResult, nytResult] = await Promise.all([
    needsRcp
      ? fetchRcpTrumpApproval().then((r) => withStaleFallback("RCP", r))
      : Promise.resolve(rcpCached!.value),
    needsNyt
      ? fetchNytTrumpApproval().then((r) => withStaleFallback("NYT", r))
      : Promise.resolve(nytCached!.value),
  ]);
  return [rcpResult, nytResult];
}

// Exposed for tests + operator tooling; lets a debug endpoint surface
// the cache state without importing the Map directly.
export function __getApprovalCacheSnapshot(): Record<string, { at: number; value: ApprovalRatingSource }> {
  return Object.fromEntries(lastGoodBySource.entries());
}
