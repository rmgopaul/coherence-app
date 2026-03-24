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
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
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

  const messages: any[] = [];
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
        return msgResponse.json();
      })
    );
    messages.push(...chunkMessages.filter(Boolean));
  }

  return messages
    .filter((message) => {
      const labels = new Set<string>(Array.isArray(message.labelIds) ? message.labelIds : []);
      return labels.has("IMPORTANT") && labels.has("UNREAD");
    })
    .sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0))
    .slice(0, cappedTotal);
}

function getHeaderValue(message: any, name: string): string {
  const headers = Array.isArray(message?.payload?.headers) ? message.payload.headers : [];
  const found = headers.find((h: any) => String(h?.name || "").toLowerCase() === name.toLowerCase());
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

  const rows: any[] = [];
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
        return threadResponse.json();
      })
    );

    for (const thread of threads) {
      if (!thread || !Array.isArray(thread.messages) || thread.messages.length === 0) continue;

      const latest = [...thread.messages].sort(
        (a: any, b: any) => Number(b?.internalDate || 0) - Number(a?.internalDate || 0)
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
  return (data.files || []).filter((file: any) => !file.trashed);
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
  return (data.files || []).filter((file: any) => !file.trashed);
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
