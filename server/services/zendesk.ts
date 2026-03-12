export type ZendeskApiContext = {
  subdomain: string;
  email: string;
  apiToken: string;
};

type ZendeskTicketRecord = {
  id: number;
  assigneeId: number | null;
  status: string | null;
};

type ZendeskUserRecord = {
  id: number;
  name: string;
  email: string | null;
  role: string | null;
};

type ZendeskTicketMetricsAccumulator = {
  assigned: number;
  newCount: number;
  open: number;
  pending: number;
  hold: number;
  solved: number;
  closed: number;
};

export type ZendeskAssigneeTicketMetrics = {
  userId: number | null;
  name: string;
  email: string | null;
  role: string | null;
  assigned: number;
  new: number;
  open: number;
  pending: number;
  hold: number;
  solved: number;
  closed: number;
};

export type ZendeskTicketMetricsResult = {
  generatedAt: string;
  maxTickets: number;
  ticketCount: number;
  truncated: boolean;
  users: ZendeskAssigneeTicketMetrics[];
  totals: {
    assigned: number;
    new: number;
    open: number;
    pending: number;
    hold: number;
    solved: number;
    closed: number;
    unassigned: number;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeZendeskSubdomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "";
  const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
  const withoutHostSuffix = withoutProtocol.replace(/\.zendesk\.com(?:\/.*)?$/, "");
  const head = withoutHostSuffix.split("/")[0]?.trim() ?? "";
  return head.replace(/[^a-z0-9-]/g, "");
}

function buildZendeskBaseUrl(context: ZendeskApiContext): string {
  const subdomain = normalizeZendeskSubdomain(context.subdomain);
  if (!subdomain) {
    throw new Error("Zendesk subdomain is required.");
  }
  return `https://${subdomain}.zendesk.com`;
}

function buildZendeskAuthHeader(context: ZendeskApiContext): string {
  const credential = `${context.email}/token:${context.apiToken}`;
  return `Basic ${Buffer.from(credential).toString("base64")}`;
}

function normalizeZendeskStatus(raw: string | null | undefined): string {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "on-hold") return "hold";
  return normalized;
}

function createAccumulator(): ZendeskTicketMetricsAccumulator {
  return {
    assigned: 0,
    newCount: 0,
    open: 0,
    pending: 0,
    hold: 0,
    solved: 0,
    closed: 0,
  };
}

async function zendeskFetchJson(
  context: ZendeskApiContext,
  urlOrPath: string,
  attempt = 0
): Promise<unknown> {
  const baseUrl = buildZendeskBaseUrl(context);
  const url = urlOrPath.startsWith("http")
    ? urlOrPath
    : `${baseUrl}${urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: buildZendeskAuthHeader(context),
    },
  });

  if (response.status === 429 && attempt < 3) {
    const retryAfterHeader = Number(response.headers.get("retry-after") ?? "1");
    const retryMs = Math.max(1, Number.isFinite(retryAfterHeader) ? retryAfterHeader : 1) * 1000;
    await sleep(retryMs);
    return zendeskFetchJson(context, urlOrPath, attempt + 1);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Zendesk request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  return response.json();
}

async function fetchTickets(context: ZendeskApiContext, maxTickets: number): Promise<{
  tickets: ZendeskTicketRecord[];
  truncated: boolean;
}> {
  const tickets: ZendeskTicketRecord[] = [];
  let nextUrl: string | null = "/api/v2/tickets.json?page[size]=100&sort_by=updated_at&sort_order=desc";
  let truncated = false;

  while (nextUrl) {
    const payload = asRecord(await zendeskFetchJson(context, nextUrl));
    const pageRows = Array.isArray(payload.tickets) ? payload.tickets : [];

    for (const row of pageRows) {
      const ticket = asRecord(row);
      const id = toNullableNumber(ticket.id);
      if (id === null) continue;
      tickets.push({
        id,
        assigneeId: toNullableNumber(ticket.assignee_id),
        status: toNonEmptyString(ticket.status),
      });
      if (tickets.length >= maxTickets) {
        truncated = true;
        break;
      }
    }

    if (truncated) break;

    const links = asRecord(payload.links);
    const meta = asRecord(payload.meta);
    const hasMore = Boolean(meta.has_more);
    const cursorNext = toNonEmptyString(links.next);
    const offsetNext = toNonEmptyString(payload.next_page);
    nextUrl = (hasMore ? cursorNext : null) ?? offsetNext ?? null;
  }

  return {
    tickets,
    truncated,
  };
}

async function fetchUsersByIds(
  context: ZendeskApiContext,
  userIds: number[]
): Promise<Map<number, ZendeskUserRecord>> {
  const map = new Map<number, ZendeskUserRecord>();
  if (userIds.length === 0) return map;

  const deduped = Array.from(new Set(userIds));
  const chunkSize = 100;

  for (let index = 0; index < deduped.length; index += chunkSize) {
    const chunk = deduped.slice(index, index + chunkSize);
    const query = encodeURIComponent(chunk.join(","));
    const payload = asRecord(await zendeskFetchJson(context, `/api/v2/users/show_many.json?ids=${query}`));
    const rows = Array.isArray(payload.users) ? payload.users : [];

    for (const row of rows) {
      const user = asRecord(row);
      const id = toNullableNumber(user.id);
      if (id === null) continue;
      map.set(id, {
        id,
        name: toNonEmptyString(user.name) ?? `User ${id}`,
        email: toNonEmptyString(user.email),
        role: toNonEmptyString(user.role),
      });
    }
  }

  return map;
}

export async function getZendeskTicketMetricsByAssignee(
  context: ZendeskApiContext,
  maxTickets = 10000
): Promise<ZendeskTicketMetricsResult> {
  const safeMaxTickets = Math.max(100, Math.min(50000, Math.floor(maxTickets)));
  const ticketResult = await fetchTickets(context, safeMaxTickets);
  const assigneeIds = ticketResult.tickets
    .map((ticket) => ticket.assigneeId)
    .filter((id): id is number => id !== null);

  const usersById = await fetchUsersByIds(context, assigneeIds);
  const byAssignee = new Map<number | null, ZendeskTicketMetricsAccumulator>();

  for (const ticket of ticketResult.tickets) {
    const key = ticket.assigneeId;
    const current = byAssignee.get(key) ?? createAccumulator();
    current.assigned += 1;

    const normalizedStatus = normalizeZendeskStatus(ticket.status);
    if (normalizedStatus === "new") current.newCount += 1;
    else if (normalizedStatus === "open") current.open += 1;
    else if (normalizedStatus === "pending") current.pending += 1;
    else if (normalizedStatus === "hold") current.hold += 1;
    else if (normalizedStatus === "solved") current.solved += 1;
    else if (normalizedStatus === "closed") current.closed += 1;

    byAssignee.set(key, current);
  }

  const users: ZendeskAssigneeTicketMetrics[] = Array.from(byAssignee.entries())
    .map(([userId, metrics]) => {
      if (userId === null) {
        return {
          userId: null,
          name: "Unassigned",
          email: null,
          role: null,
          assigned: metrics.assigned,
          new: metrics.newCount,
          open: metrics.open,
          pending: metrics.pending,
          hold: metrics.hold,
          solved: metrics.solved,
          closed: metrics.closed,
        } satisfies ZendeskAssigneeTicketMetrics;
      }

      const user = usersById.get(userId);
      return {
        userId,
        name: user?.name ?? `User ${userId}`,
        email: user?.email ?? null,
        role: user?.role ?? null,
        assigned: metrics.assigned,
        new: metrics.newCount,
        open: metrics.open,
        pending: metrics.pending,
        hold: metrics.hold,
        solved: metrics.solved,
        closed: metrics.closed,
      } satisfies ZendeskAssigneeTicketMetrics;
    })
    .sort((a, b) => {
      if (b.assigned !== a.assigned) return b.assigned - a.assigned;
      return a.name.localeCompare(b.name);
    });

  const totals = users.reduce(
    (acc, row) => {
      acc.assigned += row.assigned;
      acc.new += row.new;
      acc.open += row.open;
      acc.pending += row.pending;
      acc.hold += row.hold;
      acc.solved += row.solved;
      acc.closed += row.closed;
      if (row.userId === null) {
        acc.unassigned += row.assigned;
      }
      return acc;
    },
    {
      assigned: 0,
      new: 0,
      open: 0,
      pending: 0,
      hold: 0,
      solved: 0,
      closed: 0,
      unassigned: 0,
    }
  );

  return {
    generatedAt: new Date().toISOString(),
    maxTickets: safeMaxTickets,
    ticketCount: ticketResult.tickets.length,
    truncated: ticketResult.truncated,
    users,
    totals,
  };
}

export function normalizeZendeskSubdomainInput(raw: string): string {
  return normalizeZendeskSubdomain(raw);
}
