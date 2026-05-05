import type { HoymilesApiContext } from "./hoymiles";

export type HoymilesCredentialSource = {
  id?: string | null;
  connectionName?: string | null;
  accessToken?: string | null;
  metadata?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

export type HoymilesCredentialProfile = {
  id: string;
  credentialId: string | null;
  sourceConnectionId: string | null;
  name: string;
  username: string;
  password: string;
  baseUrl: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  context: HoymilesApiContext;
};

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseMetadata(
  raw: string | null | undefined
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rawConnectionRows(
  metadata: Record<string, unknown>
): Array<Record<string, unknown>> {
  return Array.isArray(metadata.connections)
    ? metadata.connections.filter(
        (row): row is Record<string, unknown> =>
          Boolean(row) && typeof row === "object"
      )
    : [];
}

function profileName(
  source: HoymilesCredentialSource,
  metadata: Record<string, unknown>,
  row: Record<string, unknown> | null,
  fallbackIndex: number
): string {
  return (
    toNonEmptyString(row?.name) ??
    toNonEmptyString(source.connectionName) ??
    toNonEmptyString(metadata.connectionName) ??
    `Hoymiles ${fallbackIndex + 1}`
  );
}

function buildProfile(
  source: HoymilesCredentialSource,
  metadata: Record<string, unknown>,
  row: Record<string, unknown> | null,
  fallbackIndex: number
): HoymilesCredentialProfile | null {
  const credentialId = toNonEmptyString(source.id);
  const sourceConnectionId =
    toNonEmptyString(row?.id) ??
    toNonEmptyString(metadata._sourceConnectionId) ??
    null;
  const username =
    toNonEmptyString(row?.username) ?? toNonEmptyString(metadata.username);
  const password =
    toNonEmptyString(row?.password) ??
    toNonEmptyString(metadata.password) ??
    toNonEmptyString(source.accessToken);

  if (!username || !password) return null;

  const id =
    row && sourceConnectionId
      ? credentialId
        ? `${credentialId}:${sourceConnectionId}`
        : sourceConnectionId
      : (credentialId ?? sourceConnectionId ?? `hoymiles-${fallbackIndex + 1}`);
  const baseUrl =
    toNonEmptyString(row?.baseUrl) ?? toNonEmptyString(metadata.baseUrl);
  const name = profileName(source, metadata, row, fallbackIndex);

  return {
    id,
    credentialId,
    sourceConnectionId,
    name,
    username,
    password,
    baseUrl,
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null,
    context: {
      username,
      password,
      baseUrl,
    },
  };
}

export function extractHoymilesCredentialProfiles(
  source: HoymilesCredentialSource
): HoymilesCredentialProfile[] {
  const metadata = parseMetadata(source.metadata);
  const rows = rawConnectionRows(metadata);

  const profiles =
    rows.length > 0
      ? rows
          .map((row, index) => buildProfile(source, metadata, row, index))
          .filter(
            (profile): profile is HoymilesCredentialProfile => profile !== null
          )
      : [buildProfile(source, metadata, null, 0)].filter(
          (profile): profile is HoymilesCredentialProfile => profile !== null
        );

  const seen = new Set<string>();
  return profiles.filter(profile => {
    const key = profile.id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectHoymilesCredentialProfile(
  profiles: HoymilesCredentialProfile[],
  requestedId?: string | null
): HoymilesCredentialProfile | null {
  const requested = toNonEmptyString(requestedId);
  if (!requested) return profiles[0] ?? null;
  const normalized = requested.toLowerCase();
  return (
    profiles.find(profile => profile.id.toLowerCase() === normalized) ??
    profiles.find(
      profile => profile.credentialId?.toLowerCase() === normalized
    ) ??
    profiles.find(
      profile => profile.sourceConnectionId?.toLowerCase() === normalized
    ) ??
    null
  );
}

export function maskHoymilesUsername(
  username: string | null | undefined
): string {
  const value = toNonEmptyString(username);
  if (!value) return "";
  if (value.includes("@")) {
    const [local, domain] = value.split("@");
    const visible = local.length <= 2 ? (local[0] ?? "*") : local.slice(0, 2);
    return `${visible}***@${domain}`;
  }
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}
