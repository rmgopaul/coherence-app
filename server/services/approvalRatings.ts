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

async function fetchRcpTrumpApproval(): Promise<ApprovalRatingSource> {
  try {
    const html = await fetchText(RCP_APPROVAL_URL, "text/html");
    const decoded = decodeNextFlightPayload(html);
    if (!decoded) {
      throw new Error("Unable to decode RealClear payload.");
    }

    const avgBlockMatch = decoded.match(
      /"type":"rcp_average"[\s\S]*?"date":"([^"]+)"[\s\S]*?"candidate":\[(.*?)\],"undecided"/
    );
    if (!avgBlockMatch) {
      throw new Error("RCP average block not found.");
    }

    const asOf = avgBlockMatch[1] ?? null;
    const candidateBlock = avgBlockMatch[2] ?? "";
    const approveMatch = candidateBlock.match(/"name":"Approve"[^}]*"value":"([^"]+)"/);
    const disapproveMatch = candidateBlock.match(/"name":"Disapprove"[^}]*"value":"([^"]+)"/);

    const approve = toFiniteNumber(approveMatch?.[1]);
    const disapprove = toFiniteNumber(disapproveMatch?.[1]);
    if (approve === null || disapprove === null) {
      throw new Error("RCP candidate values missing.");
    }

    return {
      source: "RCP",
      approve,
      disapprove,
      net: approve - disapprove,
      asOf,
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

export async function fetchTrumpApprovalRatings(): Promise<ApprovalRatingSource[]> {
  const [rcp, nyt] = await Promise.all([fetchRcpTrumpApproval(), fetchNytTrumpApproval()]);
  return [rcp, nyt];
}
