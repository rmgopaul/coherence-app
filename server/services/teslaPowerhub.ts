export const TESLA_POWERHUB_DEFAULT_TOKEN_URL = "https://gridlogic-api.sn.tesla.services/v1/auth/token";
export const TESLA_POWERHUB_DEFAULT_API_BASE_URL = "https://gridlogic-api.sn.tesla.services/v2";
export const TESLA_POWERHUB_DEFAULT_PORTAL_BASE_URL = "https://powerhub.energy.tesla.com";

export type TeslaPowerhubApiContext = {
  clientId: string;
  clientSecret: string;
  tokenUrl?: string | null;
  apiBaseUrl?: string | null;
  portalBaseUrl?: string | null;
};

export type TeslaPowerhubUser = {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  status: string | null;
};

type TeslaPowerhubTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeUrlOrFallback(raw: string | null | undefined, fallback: string): string {
  const normalized = (raw ?? "").trim();
  if (!normalized) return fallback;
  return normalized.replace(/\/+$/, "");
}

function buildBasicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function parseTokenPayload(payload: unknown): TeslaPowerhubTokenResponse {
  const record = asRecord(payload);
  const accessToken = toNonEmptyString(record.access_token);
  if (!accessToken) {
    throw new Error("Tesla Powerhub token response missing access_token.");
  }
  const expiresInRaw = record.expires_in;
  const expiresIn =
    typeof expiresInRaw === "number" && Number.isFinite(expiresInRaw) ? expiresInRaw : undefined;

  return {
    access_token: accessToken,
    token_type: toNonEmptyString(record.token_type) ?? undefined,
    expires_in: expiresIn,
    scope: toNonEmptyString(record.scope) ?? undefined,
  };
}

async function requestClientCredentialsToken(
  context: TeslaPowerhubApiContext
): Promise<TeslaPowerhubTokenResponse> {
  const tokenUrl = normalizeUrlOrFallback(context.tokenUrl, TESLA_POWERHUB_DEFAULT_TOKEN_URL);
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: buildBasicAuth(context.clientId, context.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Tesla Powerhub token request failed (${response.status} ${response.statusText})${text ? `: ${text}` : ""}`
    );
  }

  return parseTokenPayload(await response.json().catch(() => ({})));
}

function extractUsers(payload: unknown): TeslaPowerhubUser[] {
  const root = asRecord(payload);
  const rows = Array.isArray(root.users)
    ? root.users
    : Array.isArray(root.response)
      ? root.response
      : Array.isArray(payload)
        ? payload
        : [];

  return rows
    .map((row) => {
      const value = asRecord(row);
      const id =
        toNonEmptyString(value.id) ??
        toNonEmptyString(value.user_id) ??
        toNonEmptyString(value.uuid);
      if (!id) return null;
      return {
        id,
        name: toNonEmptyString(value.name) ?? toNonEmptyString(value.full_name) ?? `User ${id}`,
        email: toNonEmptyString(value.email),
        role: toNonEmptyString(value.role),
        status: toNonEmptyString(value.status),
      } satisfies TeslaPowerhubUser;
    })
    .filter((value): value is TeslaPowerhubUser => value !== null);
}

function buildCandidateUrls(
  context: TeslaPowerhubApiContext,
  groupId: string,
  endpointOverride: string | null
): string[] {
  const candidates: string[] = [];
  const add = (value: string | null | undefined) => {
    const normalized = toNonEmptyString(value);
    if (!normalized) return;
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  add(endpointOverride);

  const apiBase = normalizeUrlOrFallback(context.apiBaseUrl, TESLA_POWERHUB_DEFAULT_API_BASE_URL);
  const portalBase = normalizeUrlOrFallback(context.portalBaseUrl, TESLA_POWERHUB_DEFAULT_PORTAL_BASE_URL);
  const encodedGroupId = encodeURIComponent(groupId);

  add(`${apiBase}/group/${encodedGroupId}/users`);
  add(`${apiBase}/groups/${encodedGroupId}/users`);
  add(`${portalBase}/group/${encodedGroupId}/users`);
  add(`${portalBase}/groups/${encodedGroupId}/users`);

  return candidates;
}

async function fetchJsonWithBearerToken(url: string, accessToken: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`(${response.status} ${response.statusText})${text ? `: ${text}` : ""}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    throw new Error(`(Unexpected content type: ${contentType || "unknown"})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }

  return response.json();
}

export async function getTeslaPowerhubGroupUsers(
  context: TeslaPowerhubApiContext,
  options: {
    groupId: string;
    endpointUrl?: string | null;
  }
): Promise<{
  users: TeslaPowerhubUser[];
  requestedGroupId: string;
  resolvedEndpointUrl: string;
  token: {
    tokenType: string;
    expiresIn: number | null;
    scope: string | null;
  };
  raw: unknown;
}> {
  const groupId = options.groupId.trim();
  if (!groupId) {
    throw new Error("groupId is required.");
  }

  const token = await requestClientCredentialsToken(context);
  const candidateUrls = buildCandidateUrls(context, groupId, toNonEmptyString(options.endpointUrl));
  if (candidateUrls.length === 0) {
    throw new Error("No endpoint URL candidates are available.");
  }

  let lastError: string | null = null;
  for (const url of candidateUrls) {
    try {
      const raw = await fetchJsonWithBearerToken(url, token.access_token);
      return {
        users: extractUsers(raw),
        requestedGroupId: groupId,
        resolvedEndpointUrl: url,
        token: {
          tokenType: token.token_type ?? "Bearer",
          expiresIn: typeof token.expires_in === "number" ? token.expires_in : null,
          scope: token.scope ?? null,
        },
        raw,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown request error.";
    }
  }

  throw new Error(`Tesla Powerhub users request failed for all endpoint candidates.${lastError ? ` Last error ${lastError}` : ""}`);
}

export function normalizeTeslaPowerhubUrl(raw: string | null | undefined): string | null {
  const normalized = toNonEmptyString(raw);
  if (!normalized) return null;
  return normalized.replace(/\/+$/, "");
}
