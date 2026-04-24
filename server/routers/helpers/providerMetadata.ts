import { toNonEmptyString } from "../../services/core/addressCleaning";
import { parseJsonMetadata } from "./utils";

// ---------------------------------------------------------------------------
// Provider metadata types, parsers, serializers
// ---------------------------------------------------------------------------

export function parseEnphaseV4Metadata(metadata: string | null | undefined): {
  apiKey: string | null;
  clientId: string | null;
  clientSecret: string | null;
  baseUrl: string | null;
  redirectUri: string | null;
} {
  const parsed = parseJsonMetadata(metadata);
  return {
    apiKey: toNonEmptyString(parsed.apiKey),
    clientId: toNonEmptyString(parsed.clientId),
    clientSecret: toNonEmptyString(parsed.clientSecret),
    baseUrl: toNonEmptyString(parsed.baseUrl),
    redirectUri: toNonEmptyString(parsed.redirectUri),
  };
}

export function parseZendeskMetadata(metadata: string | null | undefined): {
  subdomain: string | null;
  email: string | null;
  trackedUsers: string[];
} {
  const parsed = parseJsonMetadata(metadata);
  const trackedUsersRaw = Array.isArray(parsed.trackedUsers)
    ? parsed.trackedUsers
    : [];
  const trackedUsers = trackedUsersRaw
    .map(value => toNonEmptyString(value))
    .filter((value): value is string => Boolean(value))
    .map(value => value.toLowerCase())
    .filter((value, index, array) => array.indexOf(value) === index);
  return {
    subdomain: toNonEmptyString(parsed.subdomain),
    email: toNonEmptyString(parsed.email),
    trackedUsers,
  };
}

export type EgaugeAccessType =
  | "public"
  | "user_login"
  | "site_login"
  | "portfolio_login";

export function normalizeEgaugeAccessType(value: unknown): EgaugeAccessType {
  if (
    value === "user_login" ||
    value === "site_login" ||
    value === "portfolio_login" ||
    value === "public"
  )
    return value;
  return "public";
}

export type EgaugeConnectionConfig = {
  id: string;
  name: string;
  meterId: string;
  baseUrl: string;
  accessType: EgaugeAccessType;
  username: string | null;
  password: string | null;
  createdAt: string;
  updatedAt: string;
};

export function deriveEgaugeMeterId(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase();
    const firstLabel = host.split(".")[0]?.trim();
    return firstLabel && firstLabel.length > 0 ? firstLabel : host;
  } catch {
    const normalized = baseUrl
      .replace(/^https?:\/\//i, "")
      .split(/[/?#]/)[0]
      .trim()
      .toLowerCase();
    return normalized.split(".")[0] || normalized || "egauge-meter";
  }
}

export function parseEgaugeMetadata(
  metadata: string | null | undefined,
  fallbackPassword?: string | null
): {
  activeConnectionId: string | null;
  connections: EgaugeConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];

  const connections: EgaugeConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `egauge-conn-${index + 1}`;
      const baseUrl = toNonEmptyString(row.baseUrl);
      if (!baseUrl) return null;

      const accessType = normalizeEgaugeAccessType(row.accessType);
      const createdAt =
        toNonEmptyString(row.createdAt) ?? new Date().toISOString();
      const updatedAt = toNonEmptyString(row.updatedAt) ?? createdAt;
      const username = toNonEmptyString(row.username);
      const password = toNonEmptyString(row.password);
      const meterId =
        toNonEmptyString(row.meterId)?.toLowerCase() ??
        deriveEgaugeMeterId(baseUrl).toLowerCase();

      return {
        id,
        name: toNonEmptyString(row.name) ?? `eGauge ${index + 1}`,
        meterId,
        baseUrl,
        accessType,
        username,
        password,
        createdAt,
        updatedAt,
      } satisfies EgaugeConnectionConfig;
    })
    .filter((value): value is EgaugeConnectionConfig => value !== null);

  if (connections.length === 0) {
    const legacyBaseUrl = toNonEmptyString(parsed.baseUrl);
    if (legacyBaseUrl) {
      const nowIso = new Date().toISOString();
      const legacyAccessType = normalizeEgaugeAccessType(parsed.accessType);
      const legacyUsername = toNonEmptyString(parsed.username);
      const legacyPassword = toNonEmptyString(fallbackPassword);

      connections.push({
        id: "legacy-egauge-connection",
        name: "Legacy eGauge Connection",
        meterId: deriveEgaugeMeterId(legacyBaseUrl).toLowerCase(),
        baseUrl: legacyBaseUrl,
        accessType: legacyAccessType,
        username: legacyUsername,
        password: legacyPassword,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(connection => connection.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;

  return {
    activeConnectionId,
    connections,
  };
}

export function selectEgaugeConnection(
  metadata: {
    activeConnectionId: string | null;
    connections: EgaugeConnectionConfig[];
  },
  requestedConnectionId?: string | null
): EgaugeConnectionConfig | null {
  const normalizedRequestedId = toNonEmptyString(requestedConnectionId);
  if (normalizedRequestedId) {
    return (
      metadata.connections.find(
        connection => connection.id === normalizedRequestedId
      ) ?? null
    );
  }

  return (
    metadata.connections.find(
      connection => connection.id === metadata.activeConnectionId
    ) ??
    metadata.connections[0] ??
    null
  );
}

export function serializeEgaugeMetadata(
  connections: EgaugeConnectionConfig[],
  activeConnectionId: string | null
): string {
  return JSON.stringify({
    activeConnectionId,
    connections,
  });
}

export function parseTeslaPowerhubMetadata(
  metadata: string | null | undefined
): {
  clientId: string | null;
  tokenUrl: string | null;
  apiBaseUrl: string | null;
  portalBaseUrl: string | null;
  /**
   * Tesla Powerhub Group ID the connection is scoped to. Meter-read
   * flows need this to resolve listSites and getProductionSnapshot;
   * when present, they skip prompting the user for a group per call.
   */
  groupId: string | null;
  /** Human-readable profile label shown in the saved-profiles UI. */
  connectionName: string | null;
} {
  const parsed = parseJsonMetadata(metadata);
  return {
    clientId: toNonEmptyString(parsed.clientId),
    tokenUrl: toNonEmptyString(parsed.tokenUrl),
    apiBaseUrl: toNonEmptyString(parsed.apiBaseUrl),
    portalBaseUrl: toNonEmptyString(parsed.portalBaseUrl),
    groupId: toNonEmptyString(parsed.groupId),
    connectionName: toNonEmptyString(parsed.connectionName),
  };
}

export function parseClockifyMetadata(metadata: string | null | undefined): {
  workspaceId: string | null;
  workspaceName: string | null;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
} {
  const parsed = parseJsonMetadata(metadata);
  return {
    workspaceId: toNonEmptyString(parsed.workspaceId),
    workspaceName: toNonEmptyString(parsed.workspaceName),
    userId: toNonEmptyString(parsed.userId),
    userName: toNonEmptyString(parsed.userName),
    userEmail: toNonEmptyString(parsed.userEmail),
  };
}

export function parseCsgPortalMetadata(metadata: string | null | undefined): {
  email: string | null;
  baseUrl: string | null;
  lastTestedAt: string | null;
  lastTestStatus: "success" | "failure" | null;
  lastTestMessage: string | null;
} {
  const parsed = parseJsonMetadata(metadata);
  const testStatus = toNonEmptyString(parsed.lastTestStatus);
  return {
    email: toNonEmptyString(parsed.email),
    baseUrl: toNonEmptyString(parsed.baseUrl),
    lastTestedAt: toNonEmptyString(parsed.lastTestedAt),
    lastTestStatus:
      testStatus === "success" || testStatus === "failure" ? testStatus : null,
    lastTestMessage: toNonEmptyString(parsed.lastTestMessage),
  };
}

export function serializeCsgPortalMetadata(metadata: {
  email: string | null;
  baseUrl: string | null;
  lastTestedAt?: string | null;
  lastTestStatus?: "success" | "failure" | null;
  lastTestMessage?: string | null;
}): string {
  return JSON.stringify({
    email: metadata.email,
    baseUrl: metadata.baseUrl,
    lastTestedAt: metadata.lastTestedAt ?? null,
    lastTestStatus: metadata.lastTestStatus ?? null,
    lastTestMessage: metadata.lastTestMessage ?? null,
  });
}

export function serializeZendeskMetadata(metadata: {
  subdomain: string;
  email: string;
  trackedUsers?: string[];
}): string {
  const trackedUsers = (metadata.trackedUsers ?? [])
    .map(value => toNonEmptyString(value))
    .filter((value): value is string => Boolean(value))
    .map(value => value.toLowerCase())
    .filter((value, index, array) => array.indexOf(value) === index);

  return JSON.stringify({
    subdomain: metadata.subdomain,
    email: metadata.email,
    trackedUsers,
  });
}

export type SolarEdgeConnectionConfig = {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseSolarEdgeMetadata(
  metadata: string | null | undefined,
  fallbackApiKey?: string | null
): {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: SolarEdgeConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];
  const connections: SolarEdgeConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `solaredge-conn-${index + 1}`;
      const apiKey = toNonEmptyString(row.apiKey);
      if (!apiKey) return null;
      const createdAt =
        toNonEmptyString(row.createdAt) ?? new Date().toISOString();
      const updatedAt = toNonEmptyString(row.updatedAt) ?? createdAt;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `SolarEdge API ${index + 1}`,
        apiKey,
        baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl,
        createdAt,
        updatedAt,
      } satisfies SolarEdgeConnectionConfig;
    })
    .filter((value): value is SolarEdgeConnectionConfig => value !== null);

  if (connections.length === 0) {
    const legacyApiKey = toNonEmptyString(fallbackApiKey);
    if (legacyApiKey) {
      const nowIso = new Date().toISOString();
      connections.push({
        id: "legacy-solaredge-key",
        name: "Legacy API Key",
        apiKey: legacyApiKey,
        baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(connection => connection.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;

  return {
    baseUrl,
    activeConnectionId,
    connections,
  };
}

export function serializeSolarEdgeMetadata(
  connections: SolarEdgeConnectionConfig[],
  activeConnectionId: string | null,
  baseUrl: string | null
): string {
  return JSON.stringify({
    baseUrl,
    activeConnectionId,
    connections,
  });
}

export type EnnexOsConnectionConfig = {
  id: string;
  name: string;
  accessToken: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseEnnexOsMetadata(
  metadata: string | null | undefined,
  fallbackAccessToken?: string | null
): {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: EnnexOsConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];
  const connections: EnnexOsConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `ennexos-conn-${index + 1}`;
      const accessToken = toNonEmptyString(row.accessToken);
      if (!accessToken) return null;
      const createdAt =
        toNonEmptyString(row.createdAt) ?? new Date().toISOString();
      const updatedAt = toNonEmptyString(row.updatedAt) ?? createdAt;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `ennexOS API ${index + 1}`,
        accessToken,
        baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl,
        createdAt,
        updatedAt,
      } satisfies EnnexOsConnectionConfig;
    })
    .filter((value): value is EnnexOsConnectionConfig => value !== null);

  if (connections.length === 0) {
    const legacyAccessToken = toNonEmptyString(fallbackAccessToken);
    if (legacyAccessToken) {
      const nowIso = new Date().toISOString();
      connections.push({
        id: "legacy-ennexos-token",
        name: "Legacy Access Token",
        accessToken: legacyAccessToken,
        baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(connection => connection.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;

  return {
    baseUrl,
    activeConnectionId,
    connections,
  };
}

export function serializeEnnexOsMetadata(
  connections: EnnexOsConnectionConfig[],
  activeConnectionId: string | null,
  baseUrl: string | null
): string {
  return JSON.stringify({
    baseUrl,
    activeConnectionId,
    connections,
  });
}

export type FroniusConnectionConfig = {
  id: string;
  name: string;
  accessKeyId: string;
  accessKeyValue: string;
  createdAt: string;
  updatedAt: string;
};

export function parseFroniusMetadata(
  metadata: string | null | undefined,
  fallbackAccessKeyId?: string | null
): {
  activeConnectionId: string | null;
  connections: FroniusConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];
  const connections: FroniusConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `fronius-conn-${index + 1}`;
      const accessKeyId = toNonEmptyString(row.accessKeyId);
      const accessKeyValue = toNonEmptyString(row.accessKeyValue);
      if (!accessKeyId || !accessKeyValue) return null;
      const createdAt =
        toNonEmptyString(row.createdAt) ?? new Date().toISOString();
      const updatedAt = toNonEmptyString(row.updatedAt) ?? createdAt;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `Fronius API ${index + 1}`,
        accessKeyId,
        accessKeyValue,
        createdAt,
        updatedAt,
      } satisfies FroniusConnectionConfig;
    })
    .filter((value): value is FroniusConnectionConfig => value !== null);

  if (connections.length === 0) {
    const legacyKeyId = toNonEmptyString(fallbackAccessKeyId);
    if (legacyKeyId) {
      const nowIso = new Date().toISOString();
      connections.push({
        id: "legacy-fronius-key",
        name: "Legacy Access Key",
        accessKeyId: legacyKeyId,
        accessKeyValue: "",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(c => c.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;

  return { activeConnectionId, connections };
}

export function serializeFroniusMetadata(
  connections: FroniusConnectionConfig[],
  activeConnectionId: string | null
): string {
  return JSON.stringify({ activeConnectionId, connections });
}

// ---------------------------------------------------------------------------
// Solar cloud connection configs (Solis, GoodWe, Generac, Locus, Growatt,
// APsystems, EKM, Hoymiles, SolarLog)
// ---------------------------------------------------------------------------

export type SolisConnectionConfig = {
  id: string;
  name: string;
  apiKey: string;
  apiSecret: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseSolisMetadata(
  metadata: string | null | undefined,
  fallbackApiKey?: string | null
): {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: SolisConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];
  const connections: SolisConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `solis-conn-${index + 1}`;
      const apiKey = toNonEmptyString(row.apiKey);
      const apiSecret = toNonEmptyString(row.apiSecret);
      if (!apiKey || !apiSecret) return null;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `Solis API ${index + 1}`,
        apiKey,
        apiSecret,
        baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl,
        createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(),
        updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString(),
      } satisfies SolisConnectionConfig;
    })
    .filter((v): v is SolisConnectionConfig => v !== null);
  if (connections.length === 0 && fallbackApiKey) {
    const legacyKey = toNonEmptyString(fallbackApiKey);
    if (legacyKey) {
      const nowIso = new Date().toISOString();
      connections.push({
        id: "legacy-solis-key",
        name: "Legacy API Key",
        apiKey: legacyKey,
        apiSecret: "",
        baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }
  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(c => c.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeSolisMetadata(
  connections: SolisConnectionConfig[],
  activeConnectionId: string | null,
  baseUrl: string | null
): string {
  return JSON.stringify({ baseUrl, activeConnectionId, connections });
}

export type GoodWeConnectionConfig = {
  id: string;
  name: string;
  account: string;
  password: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseGoodWeMetadata(metadata: string | null | undefined): {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: GoodWeConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];
  const connections: GoodWeConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `goodwe-conn-${index + 1}`;
      const account = toNonEmptyString(row.account);
      const password = toNonEmptyString(row.password);
      if (!account || !password) return null;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `GoodWe ${index + 1}`,
        account,
        password,
        baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl,
        createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(),
        updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString(),
      } satisfies GoodWeConnectionConfig;
    })
    .filter((v): v is GoodWeConnectionConfig => v !== null);
  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(c => c.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeGoodWeMetadata(
  connections: GoodWeConnectionConfig[],
  activeConnectionId: string | null,
  baseUrl: string | null
): string {
  return JSON.stringify({ baseUrl, activeConnectionId, connections });
}

export type GeneracConnectionConfig = {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseGeneracMetadata(
  metadata: string | null | undefined,
  fallbackApiKey?: string | null
): {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: GeneracConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];
  const connections: GeneracConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `generac-conn-${index + 1}`;
      const apiKey = toNonEmptyString(row.apiKey);
      if (!apiKey) return null;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `Generac API ${index + 1}`,
        apiKey,
        baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl,
        createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(),
        updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString(),
      } satisfies GeneracConnectionConfig;
    })
    .filter((v): v is GeneracConnectionConfig => v !== null);
  if (connections.length === 0 && fallbackApiKey) {
    const legacyKey = toNonEmptyString(fallbackApiKey);
    if (legacyKey) {
      const nowIso = new Date().toISOString();
      connections.push({
        id: "legacy-generac-key",
        name: "Legacy API Key",
        apiKey: legacyKey,
        baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }
  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(c => c.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeGeneracMetadata(
  connections: GeneracConnectionConfig[],
  activeConnectionId: string | null,
  baseUrl: string | null
): string {
  return JSON.stringify({ baseUrl, activeConnectionId, connections });
}

export type LocusConnectionConfig = {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  partnerId: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseLocusMetadata(metadata: string | null | undefined): {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: LocusConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];
  const connections: LocusConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `locus-conn-${index + 1}`;
      const clientId = toNonEmptyString(row.clientId);
      const clientSecret = toNonEmptyString(row.clientSecret);
      const partnerId = toNonEmptyString(row.partnerId);
      if (!clientId || !clientSecret || !partnerId) return null;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `Locus API ${index + 1}`,
        clientId,
        clientSecret,
        partnerId,
        baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl,
        createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(),
        updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString(),
      } satisfies LocusConnectionConfig;
    })
    .filter((v): v is LocusConnectionConfig => v !== null);
  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(c => c.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeLocusMetadata(
  connections: LocusConnectionConfig[],
  activeConnectionId: string | null,
  baseUrl: string | null
): string {
  return JSON.stringify({ baseUrl, activeConnectionId, connections });
}

export type GrowattConnectionConfig = {
  id: string;
  name: string;
  username: string;
  password: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseGrowattMetadata(metadata: string | null | undefined): {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: GrowattConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];
  const connections: GrowattConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `growatt-conn-${index + 1}`;
      const username = toNonEmptyString(row.username);
      const password = toNonEmptyString(row.password);
      if (!username || !password) return null;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `Growatt ${index + 1}`,
        username,
        password,
        baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl,
        createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(),
        updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString(),
      } satisfies GrowattConnectionConfig;
    })
    .filter((v): v is GrowattConnectionConfig => v !== null);
  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(c => c.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeGrowattMetadata(
  connections: GrowattConnectionConfig[],
  activeConnectionId: string | null,
  baseUrl: string | null
): string {
  return JSON.stringify({ baseUrl, activeConnectionId, connections });
}

export type APsystemsConnectionConfig = {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseAPsystemsMetadata(
  metadata: string | null | undefined,
  fallbackApiKey?: string | null
): {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: APsystemsConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];
  const connections: APsystemsConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `apsystems-conn-${index + 1}`;
      const appId = toNonEmptyString(row.appId) ?? toNonEmptyString(row.apiKey);
      const appSecret = toNonEmptyString(row.appSecret) ?? "";
      if (!appId) return null;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `APsystems API ${index + 1}`,
        appId,
        appSecret,
        baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl,
        createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(),
        updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString(),
      } satisfies APsystemsConnectionConfig;
    })
    .filter((v): v is APsystemsConnectionConfig => v !== null);
  if (connections.length === 0 && fallbackApiKey) {
    const legacyKey = toNonEmptyString(fallbackApiKey);
    if (legacyKey) {
      const nowIso = new Date().toISOString();
      connections.push({
        id: "legacy-apsystems-key",
        name: "Legacy API Key",
        appId: legacyKey,
        appSecret: "",
        baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }
  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(c => c.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeAPsystemsMetadata(
  connections: APsystemsConnectionConfig[],
  activeConnectionId: string | null,
  baseUrl: string | null
): string {
  return JSON.stringify({ baseUrl, activeConnectionId, connections });
}

export type EkmConnectionConfig = {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseEkmMetadata(
  metadata: string | null | undefined,
  fallbackApiKey?: string | null
): {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: EkmConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];
  const connections: EkmConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `ekm-conn-${index + 1}`;
      const apiKey = toNonEmptyString(row.apiKey);
      if (!apiKey) return null;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `EKM API ${index + 1}`,
        apiKey,
        baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl,
        createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(),
        updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString(),
      } satisfies EkmConnectionConfig;
    })
    .filter((v): v is EkmConnectionConfig => v !== null);
  if (connections.length === 0 && fallbackApiKey) {
    const legacyKey = toNonEmptyString(fallbackApiKey);
    if (legacyKey) {
      const nowIso = new Date().toISOString();
      connections.push({
        id: "legacy-ekm-key",
        name: "Legacy API Key",
        apiKey: legacyKey,
        baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }
  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(c => c.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeEkmMetadata(
  connections: EkmConnectionConfig[],
  activeConnectionId: string | null,
  baseUrl: string | null
): string {
  return JSON.stringify({ baseUrl, activeConnectionId, connections });
}

export type HoymilesConnectionConfig = {
  id: string;
  name: string;
  username: string;
  password: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseHoymilesMetadata(metadata: string | null | undefined): {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: HoymilesConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];
  const connections: HoymilesConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `hoymiles-conn-${index + 1}`;
      const username = toNonEmptyString(row.username);
      const password = toNonEmptyString(row.password);
      if (!username || !password) return null;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `Hoymiles ${index + 1}`,
        username,
        password,
        baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl,
        createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(),
        updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString(),
      } satisfies HoymilesConnectionConfig;
    })
    .filter((v): v is HoymilesConnectionConfig => v !== null);
  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(c => c.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeHoymilesMetadata(
  connections: HoymilesConnectionConfig[],
  activeConnectionId: string | null,
  baseUrl: string | null
): string {
  return JSON.stringify({ baseUrl, activeConnectionId, connections });
}

export type SolarLogConnectionConfig = {
  id: string;
  name: string;
  baseUrl: string;
  password: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseSolarLogMetadata(metadata: string | null | undefined): {
  activeConnectionId: string | null;
  connections: SolarLogConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];
  const connections: SolarLogConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const id = toNonEmptyString(row.id) ?? `solarlog-conn-${index + 1}`;
      const baseUrl = toNonEmptyString(row.baseUrl);
      if (!baseUrl) return null;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `Solar-Log ${index + 1}`,
        baseUrl,
        password: toNonEmptyString(row.password) ?? null,
        createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(),
        updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString(),
      } satisfies SolarLogConnectionConfig;
    })
    .filter((v): v is SolarLogConnectionConfig => v !== null);
  const activeConnectionId =
    (activeConnectionIdRaw &&
    connections.some(c => c.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;
  return { activeConnectionId, connections };
}

export function serializeSolarLogMetadata(
  connections: SolarLogConnectionConfig[],
  activeConnectionId: string | null
): string {
  return JSON.stringify({ activeConnectionId, connections });
}
