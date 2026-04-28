// Helper function to make Google API calls with automatic retry
async function makeGoogleApiCall(url: string, accessToken: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
  throw new Error("Failed after retries");
}

type CalendarEventsOptions = {
  startIso?: string;
  endIso?: string;
  daysAhead?: number;
  maxResults?: number;
};

function parseDateOrFallback(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export async function getGoogleCalendarEvents(
  accessToken: string,
  options: CalendarEventsOptions = {}
): Promise<any[]> {
  const now = new Date();
  const safeDaysAhead = Math.max(1, Math.min(options.daysAhead ?? 30, 365));
  const start = parseDateOrFallback(options.startIso, now);
  const fallbackEnd = new Date(start.getTime() + safeDaysAhead * 24 * 60 * 60 * 1000);
  const end = parseDateOrFallback(options.endIso, fallbackEnd);
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 100, 250));
  const orderedWindow = end.getTime() > start.getTime()
    ? { timeMin: start.toISOString(), timeMax: end.toISOString() }
    : { timeMin: start.toISOString(), timeMax: fallbackEnd.toISOString() };

  const params = new URLSearchParams({
    timeMin: orderedWindow.timeMin,
    timeMax: orderedWindow.timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(maxResults),
  });

  const response = await makeGoogleApiCall(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    accessToken
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Google Calendar API] Error ${response.status}:`, errorText);
    throw new Error(`Google Calendar API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.items || [];
}

export async function getGmailMessages(accessToken: string, maxResults = 50): Promise<any[]> {
  // Strictly fetch Important + Unread messages.
  const query = encodeURIComponent("is:important is:unread");
  const cappedTotal = Math.max(1, Math.min(maxResults, 800));
  const messageIds: Array<{ id: string }> = [];
  let pageToken: string | undefined;

  while (messageIds.length < cappedTotal) {
    const pageSize = Math.min(500, cappedTotal - messageIds.length);
    const pageTokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const response = await makeGoogleApiCall(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${pageSize}&labelIds=IMPORTANT&labelIds=UNREAD&q=${query}${pageTokenParam}`,
      accessToken
    );

    if (!response.ok) {
      throw new Error(`Gmail API error: ${response.statusText}`);
    }

    const data = await response.json();
    if (Array.isArray(data.messages)) {
      messageIds.push(...data.messages);
    }
    if (!data.nextPageToken) {
      break;
    }
    pageToken = data.nextPageToken;
  }

  if (messageIds.length === 0) {
    return [];
  }

  const messages: Record<string, unknown>[] = [];
  const chunkSize = 50;

  for (let i = 0; i < messageIds.length; i += chunkSize) {
    const chunk = messageIds.slice(i, i + chunkSize);
    const chunkMessages = await Promise.all(
      chunk.map(async (msg) => {
        const msgResponse = await makeGoogleApiCall(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          accessToken
        );
        if (!msgResponse.ok) return null;
        return msgResponse.json() as Promise<Record<string, unknown>>;
      })
    );
    messages.push(...chunkMessages.filter((m): m is Record<string, unknown> => m !== null));
  }

  return messages
    .filter((message) => {
      const labels = new Set<string>(Array.isArray(message.labelIds) ? message.labelIds : []);
      return labels.has("IMPORTANT") && labels.has("UNREAD");
    })
    .sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0))
    .slice(0, cappedTotal);
}

type GmailHeader = { name?: string; value?: string };
function getHeaderValue(message: unknown, name: string): string {
  const payload = (message as { payload?: { headers?: unknown } } | null)?.payload;
  const headers: GmailHeader[] = Array.isArray(payload?.headers) ? (payload.headers as GmailHeader[]) : [];
  const found = headers.find((h: GmailHeader) => String(h?.name || "").toLowerCase() === name.toLowerCase());
  return String(found?.value || "");
}

export async function getGmailWaitingOn(accessToken: string, maxResults = 25): Promise<any[]> {
  // Approximation for "awaiting response": latest message in thread is SENT by me.
  const cappedTotal = Math.max(1, Math.min(maxResults, 100));
  const scanLimit = Math.max(30, Math.min(cappedTotal * 4, 200));
  const query = encodeURIComponent("in:sent newer_than:30d");
  const threadIds: Array<{ id: string }> = [];
  let pageToken: string | undefined;

  while (threadIds.length < scanLimit) {
    const pageSize = Math.min(100, scanLimit - threadIds.length);
    const pageTokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const response = await makeGoogleApiCall(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=${pageSize}&q=${query}${pageTokenParam}`,
      accessToken
    );

    if (!response.ok) {
      throw new Error(`Gmail API error: ${response.statusText}`);
    }

    const data = await response.json();
    if (Array.isArray(data.threads)) {
      threadIds.push(...data.threads);
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  if (threadIds.length === 0) return [];

  type GmailMessage = {
    id?: string;
    threadId?: string;
    internalDate?: string | number;
    snippet?: string;
    labelIds?: string[];
    payload?: { headers?: GmailHeader[] };
  };
  type GmailThread = { id?: string; messages?: GmailMessage[] };
  type WaitingOnRow = {
    id: string;
    threadId: string;
    from: string;
    to: string;
    subject: string;
    snippet: string;
    date: string;
    reason: string;
    score: number;
    url: string;
  };
  const rows: WaitingOnRow[] = [];
  const chunkSize = 20;

  for (let i = 0; i < threadIds.length; i += chunkSize) {
    const chunk = threadIds.slice(i, i + chunkSize);
    const threads = await Promise.all(
      chunk.map(async (thread) => {
        const threadResponse = await makeGoogleApiCall(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${thread.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          accessToken
        );
        if (!threadResponse.ok) return null;
        return threadResponse.json() as Promise<GmailThread>;
      })
    );

    for (const thread of threads) {
      if (!thread || !Array.isArray(thread.messages) || thread.messages.length === 0) continue;

      const latest = [...thread.messages].sort(
        (a: GmailMessage, b: GmailMessage) => Number(b?.internalDate || 0) - Number(a?.internalDate || 0)
      )[0];
      if (!latest) continue;

      const latestLabels = new Set<string>(Array.isArray(latest.labelIds) ? latest.labelIds : []);
      if (!latestLabels.has("SENT")) continue;

      const to = getHeaderValue(latest, "To");
      const from = getHeaderValue(latest, "From");
      const subject = getHeaderValue(latest, "Subject") || "(No subject)";
      const date = getHeaderValue(latest, "Date");

      rows.push({
        id: String(latest.id || ""),
        threadId: String(thread.id || latest.threadId || ""),
        from,
        to,
        subject,
        snippet: String(latest.snippet || ""),
        date,
        reason: "Awaiting response to sent email",
        score: 3,
        url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(String(thread.id || latest.threadId || latest.id || ""))}`,
      });
    }
  }

  return rows
    .sort((a, b) => {
      const aTs = new Date(a.date || 0).getTime();
      const bTs = new Date(b.date || 0).getTime();
      const safeA = Number.isFinite(aTs) ? aTs : 0;
      const safeB = Number.isFinite(bTs) ? bTs : 0;
      return safeB - safeA;
    })
    .slice(0, cappedTotal);
}

/**
 * Archive a Gmail thread/message by removing the INBOX label.
 * "Archive" in Gmail's data model = INBOX label removed but the
 * thread stays in All Mail. The same /modify endpoint that
 * `markGmailMessageAsRead` uses, just with a different label.
 *
 * Task 10.1 (2026-04-28) — wired up by the SignalActions menu so
 * Gmail rows can be archived from the dashboard without leaving
 * the page.
 */
export async function archiveGmailMessage(
  accessToken: string,
  messageId: string
): Promise<void> {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        removeLabelIds: ["INBOX"],
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Failed to archive email: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`
    );
  }
}

export async function markGmailMessageAsRead(accessToken: string, messageId: string): Promise<void> {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        removeLabelIds: ["UNREAD"],
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Failed to mark email as read: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`
    );
  }
}

export async function getGoogleDriveFiles(accessToken: string): Promise<any[]> {
  const query = encodeURIComponent("trashed = false");
  const response = await makeGoogleApiCall(
    `https://www.googleapis.com/drive/v3/files?q=${query}&pageSize=20&orderBy=modifiedTime desc&fields=files(id,name,mimeType,modifiedTime,webViewLink,iconLink,trashed)`,
    accessToken
  );

  if (!response.ok) {
    throw new Error(`Drive API error: ${response.statusText}`);
  }

  const data = await response.json();
  type DriveFile = { trashed?: boolean };
  return ((data.files || []) as DriveFile[]).filter((file: DriveFile) => !file.trashed);
}

export async function searchGoogleDrive(accessToken: string, query: string): Promise<any[]> {
  const safeQuery = query.replace(/'/g, "\\'");
  const encodedQuery = encodeURIComponent(`trashed = false and name contains '${safeQuery}'`);
  const response = await makeGoogleApiCall(
    `https://www.googleapis.com/drive/v3/files?q=${encodedQuery}&pageSize=20&fields=files(id,name,mimeType,modifiedTime,webViewLink,iconLink,trashed)`,
    accessToken
  );

  if (!response.ok) {
    throw new Error(`Drive search error: ${response.statusText}`);
  }

  const data = await response.json();
  type DriveFile = { trashed?: boolean };
  return ((data.files || []) as DriveFile[]).filter((file: DriveFile) => !file.trashed);
}

export async function createGoogleSpreadsheet(accessToken: string, title: string): Promise<any> {
  const response = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: { title },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Sheets API error: ${response.statusText}`);
  }

  const data = await response.json();
  return {
    spreadsheetId: data.spreadsheetId,
    webViewLink: data.spreadsheetUrl,
  };
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to exchange Google code: ${error}`);
  }

  return response.json();
}

export async function refreshGoogleToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error("Failed to refresh Google token");
  }

  return response.json();
}

// ────────────────────────────────────────────────────────────────────
// Google Drive folder-linking helpers (drive-link-v1)
//
// Used by server/routers.ts linkScheduleBDriveFolder + the drive branch
// in server/services/core/scheduleBImportJobRunner.ts. The whole feature
// lives in the server so the browser never has to touch the PDF bytes
// — that's the entire point. See docs in the plan file
// .claude/plans/wise-stargazing-peacock.md.
// ────────────────────────────────────────────────────────────────────

const DRIVE_FOLDER_URL_REGEX = /\/folders\/([a-zA-Z0-9_-]+)/;
const DRIVE_RAW_ID_REGEX = /^[a-zA-Z0-9_-]{10,}$/;

/**
 * Parse a Google Drive folder ID out of any of these inputs:
 *  - https://drive.google.com/drive/folders/ABC123_-def
 *  - https://drive.google.com/drive/folders/ABC123_-def?usp=sharing
 *  - https://drive.google.com/drive/u/0/folders/ABC123_-def
 *  - raw ID like ABC123_-def
 *
 * Returns null if the input can't be interpreted as a folder ID.
 */
export function parseGoogleDriveFolderId(input: string): string | null {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return null;
  const match = trimmed.match(DRIVE_FOLDER_URL_REGEX);
  if (match) return match[1];
  if (DRIVE_RAW_ID_REGEX.test(trimmed)) return trimmed;
  return null;
}

/**
 * List every PDF in a Drive folder (top-level only, no recursion).
 * Paginates via nextPageToken until the folder is fully enumerated,
 * then returns a flat array of {id, name, size}. Mirrors the pagination
 * pattern used by getGmailMessages above.
 *
 * Supports both My Drive and Shared Drives — supportsAllDrives +
 * includeItemsFromAllDrives are set defensively so the call works
 * across either source with no behavioral difference on My Drive.
 *
 * Throws if the running total exceeds opts.maxFiles (default 100_000)
 * so we never block the server on a pathological folder.
 *
 * The caller MUST pass a token that was produced by getValidGoogleToken
 * (or otherwise freshly refreshed) — this helper doesn't know how to
 * recover from 401.
 */
export async function listGoogleDrivePdfsInFolder(
  accessToken: string,
  folderId: string,
  opts: { maxFiles?: number; maxDepth?: number } = {}
): Promise<Array<{ id: string; name: string; size: number | null }>> {
  const maxFiles = opts.maxFiles ?? 100_000;
  const maxDepth = opts.maxDepth ?? 10;
  const results: Array<{ id: string; name: string; size: number | null }> = [];

  const listItemsInFolder = async (
    parentId: string,
    mimeFilter: string,
    fieldsSpec: string
  ): Promise<Array<Record<string, unknown>>> => {
    const query = `'${parentId}' in parents and ${mimeFilter} and trashed=false`;
    const items: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined = undefined;
    const pageSize = 1000;
    const maxIterations = Math.ceil(maxFiles / pageSize) + 2;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const params = new URLSearchParams({
        q: query,
        pageSize: String(pageSize),
        fields: fieldsSpec,
        orderBy: "name",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const response = await makeGoogleApiCall(
        `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
        accessToken
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Drive folder list failed: ${response.status} ${response.statusText}${
            body ? ` — ${body.slice(0, 300)}` : ""
          }`
        );
      }

      const data = (await response.json()) as {
        files?: Array<Record<string, unknown>>;
        nextPageToken?: string;
      };
      const files = Array.isArray(data.files) ? data.files : [];
      items.push(...files);

      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    return items;
  };

  const scanFolder = async (currentFolderId: string, depth: number): Promise<void> => {
    // List PDFs in this folder
    const pdfItems = await listItemsInFolder(
      currentFolderId,
      "mimeType='application/pdf'",
      "files(id,name,size),nextPageToken"
    );

    for (const f of pdfItems) {
      if (!f.id || !f.name) continue;
      const sizeStr = typeof f.size === "string" ? f.size : null;
      const sizeNum = sizeStr ? Number(sizeStr) : null;
      results.push({
        id: f.id as string,
        name: f.name as string,
        size: Number.isFinite(sizeNum as number) ? (sizeNum as number) : null,
      });

      if (results.length > maxFiles) {
        throw new Error(
          `Drive folder tree contains more than ${maxFiles.toLocaleString()} PDFs. Please use a smaller folder.`
        );
      }
    }

    // Recurse into subfolders (if within depth limit)
    if (depth < maxDepth) {
      const subfolders = await listItemsInFolder(
        currentFolderId,
        "mimeType='application/vnd.google-apps.folder'",
        "files(id,name),nextPageToken"
      );

      for (const sf of subfolders) {
        if (!sf.id) continue;
        await scanFolder(sf.id as string, depth + 1);
      }
    }
  };

  await scanFolder(folderId, 0);
  return results;
}

/**
 * Download a single Drive file's raw bytes via alt=media.
 *
 * Uses its own `fetch` (not `makeGoogleApiCall`) so we can set a
 * download-appropriate timeout of 60 seconds — the shared wrapper's
 * 15s ceiling is too tight for larger PDFs on slow networks. Retries
 * network errors up to 3 times with linear backoff, and handles
 * rate-limit (429) with Retry-After once before failing.
 *
 * Throws on 4xx/5xx with a diagnosable message; the runner wraps this
 * in its per-file try/catch and writes a failed result row.
 *
 * The caller MUST pass a fresh access token — 401 is not auto-refreshed.
 */
export async function downloadGoogleDriveFile(
  accessToken: string,
  fileId: string
): Promise<Uint8Array> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId
  )}?alt=media&supportsAllDrives=true`;

  const doFetch = async (): Promise<Response> => {
    return fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(60_000),
    });
  };

  const maxNetworkRetries = 3;
  let lastNetworkError: unknown = null;
  let sawRateLimit = false;

  for (let attempt = 0; attempt < maxNetworkRetries; attempt += 1) {
    let response: Response;
    try {
      response = await doFetch();
    } catch (err) {
      lastNetworkError = err;
      if (attempt === maxNetworkRetries - 1) break;
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * (attempt + 1))
      );
      continue;
    }

    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    }

    // Specific 429 handling: parse Retry-After and try exactly once
    // more. A second 429 in a row fails the file.
    if (response.status === 429 && !sawRateLimit) {
      sawRateLimit = true;
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSec = retryAfterHeader
        ? Math.max(0, Math.min(60, Number(retryAfterHeader) || 0))
        : 2;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(retryAfterSec, 1) * 1000)
      );
      continue;
    }

    // Any other non-ok status: throw with a diagnosable message.
    const body = await response.text().catch(() => "");
    throw new Error(
      `Drive download failed: ${response.status} ${response.statusText}${
        body ? ` — ${body.slice(0, 300)}` : ""
      }`
    );
  }

  throw lastNetworkError instanceof Error
    ? lastNetworkError
    : new Error("Drive download failed after network retries");
}
