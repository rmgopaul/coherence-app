/**
 * Tesla Powerhub monitoring adapter.
 *
 * Key fixes:
 * - listSites throws with descriptive errors when all connections fail
 *   (instead of returning empty array → silent skip)
 * - getSnapshots returns "Error" with actual messages when API fails
 *   (instead of "Not Found" which hides real failures)
 * - Cache auto-clears on rejected promises so retries work
 */
import {
  getTeslaPowerhubProductionMetrics,
  listTeslaPowerhubSites,
  type TeslaPowerhubApiContext,
  type TeslaPowerhubSiteProductionMetrics,
} from "../../services/solar/teslaPowerhub";
import { toNonEmptyString } from "../../services/solar/teslaPowerhubUtils";

type TeslaPowerhubConnection = TeslaPowerhubApiContext & {
  groupId: string | null;
  endpointUrl?: string | null;
  signal?: string | null;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 120;

const groupMetricsCache = new Map<
  string,
  {
    createdAt: number;
    promise: Promise<TeslaPowerhubSiteProductionMetrics[]>;
  }
>();

function extractGroupIdFromUrl(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/\/group\/([a-zA-Z0-9-]+)/i);
  return match?.[1]?.trim() ?? null;
}

function extractUuidLike(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  return match?.[0] ?? null;
}

function buildCacheKey(
  connection: TeslaPowerhubConnection,
  anchorDate: string
): string {
  return [
    connection.clientId,
    connection.groupId ?? "auto",
    connection.tokenUrl ?? "",
    connection.apiBaseUrl ?? "",
    connection.portalBaseUrl ?? "",
    connection.endpointUrl ?? "",
    connection.signal ?? "",
    anchorDate,
  ].join("::");
}

function trimGroupMetricsCache() {
  if (groupMetricsCache.size <= CACHE_MAX_ENTRIES) return;
  const sorted = Array.from(groupMetricsCache.entries()).sort(
    (a, b) => a[1].createdAt - b[1].createdAt
  );
  const toDrop = sorted.slice(
    0,
    Math.max(1, groupMetricsCache.size - CACHE_MAX_ENTRIES)
  );
  toDrop.forEach(([key]) => groupMetricsCache.delete(key));
}

function parseConnections(credential: {
  accessToken?: string | null;
  metadata?: string | null;
}): TeslaPowerhubConnection[] {
  const fallbackSecret = toNonEmptyString(credential.accessToken);
  if (!credential.metadata) return [];
  try {
    const meta = JSON.parse(credential.metadata);
    const rows = Array.isArray(meta.connections) ? meta.connections : [meta];

    return rows
      .map((row: unknown) => {
        const record = (row && typeof row === "object" ? row : {}) as Record<
          string,
          unknown
        >;
        const clientId =
          toNonEmptyString(record.clientId) ?? toNonEmptyString(meta.clientId);
        const clientSecret =
          toNonEmptyString(record.clientSecret) ??
          toNonEmptyString(meta.clientSecret) ??
          fallbackSecret;
        const endpointUrl =
          toNonEmptyString(record.endpointUrl) ??
          toNonEmptyString(meta.endpointUrl);
        const portalBaseUrl =
          toNonEmptyString(record.portalBaseUrl) ??
          toNonEmptyString(meta.portalBaseUrl);
        const connectionName =
          toNonEmptyString(record.connectionName) ??
          toNonEmptyString(meta.connectionName);
        const sourceConnectionId =
          toNonEmptyString(record.sourceConnectionId) ??
          toNonEmptyString(meta.sourceConnectionId) ??
          toNonEmptyString(record._sourceConnectionId) ??
          toNonEmptyString(meta._sourceConnectionId);
        const groupId =
          toNonEmptyString(record.groupId) ??
          toNonEmptyString(meta.groupId) ??
          extractGroupIdFromUrl(endpointUrl) ??
          extractGroupIdFromUrl(portalBaseUrl) ??
          extractUuidLike(connectionName) ??
          extractUuidLike(sourceConnectionId);
        if (!clientId || !clientSecret) return null;
        return {
          clientId,
          clientSecret,
          groupId,
          tokenUrl:
            toNonEmptyString(record.tokenUrl) ??
            toNonEmptyString(meta.tokenUrl),
          apiBaseUrl:
            toNonEmptyString(record.apiBaseUrl) ??
            toNonEmptyString(meta.apiBaseUrl),
          portalBaseUrl,
          endpointUrl,
          signal:
            toNonEmptyString(record.signal) ?? toNonEmptyString(meta.signal),
        } satisfies TeslaPowerhubConnection;
      })
      .filter(
        (
          connection: TeslaPowerhubConnection | null
        ): connection is TeslaPowerhubConnection => connection !== null
      );
  } catch {
    return [];
  }
}

async function loadGroupSites(
  connection: TeslaPowerhubConnection,
  anchorDate: string
): Promise<TeslaPowerhubSiteProductionMetrics[]> {
  const cacheKey = buildCacheKey(connection, anchorDate);
  const now = Date.now();
  const cached = groupMetricsCache.get(cacheKey);
  if (cached && now - cached.createdAt <= CACHE_TTL_MS) {
    return cached.promise;
  }

  const promise = getTeslaPowerhubProductionMetrics(
    {
      clientId: connection.clientId,
      clientSecret: connection.clientSecret,
      tokenUrl: connection.tokenUrl,
      apiBaseUrl: connection.apiBaseUrl,
      portalBaseUrl: connection.portalBaseUrl,
    },
    {
      groupId: connection.groupId,
      endpointUrl: connection.endpointUrl,
      signal: connection.signal,
      globalTimeoutMs: 5 * 60 * 1000,
      fetchExternalIds: false,
      includeDebugPreviews: false,
      perSiteGapFillMode: "group-only",
    }
  )
    .then(result => result.sites)
    .catch(error => {
      // Clear failed cache entry so the next call retries fresh
      groupMetricsCache.delete(cacheKey);
      throw error;
    });

  groupMetricsCache.set(cacheKey, { createdAt: now, promise });
  trimGroupMetricsCache();
  return promise;
}

const adapter = {
  supportsBulkSnapshots: true,
  snapshotTimeoutMs: 6 * 60 * 1000,

  async listSites(credential: {
    accessToken?: string | null;
    metadata?: string | null;
  }) {
    const connections = parseConnections(credential);
    if (connections.length === 0) {
      throw new Error(
        "Tesla Powerhub setup is missing required values. Save clientId and clientSecret in Solar REC Settings > API Credentials."
      );
    }

    const sitesById = new Map<string, { siteId: string; siteName: string }>();
    const errors: string[] = [];
    for (const connection of connections) {
      try {
        const result = await listTeslaPowerhubSites(
          {
            clientId: connection.clientId,
            clientSecret: connection.clientSecret,
            tokenUrl: connection.tokenUrl,
            apiBaseUrl: connection.apiBaseUrl,
            portalBaseUrl: connection.portalBaseUrl,
          },
          {
            groupId: connection.groupId,
            endpointUrl: connection.endpointUrl,
          }
        );
        if (result.sites.length === 0) {
          throw new Error("No Tesla Powerhub sites discovered.");
        }
        result.sites.forEach(site => {
          if (sitesById.has(site.siteId)) return;
          sitesById.set(site.siteId, {
            siteId: site.siteId,
            siteName: site.siteName ?? site.siteExternalId ?? site.siteId,
          });
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[Tesla Powerhub adapter] listSites error:", msg);
        errors.push(msg);
      }
    }

    // If all connections failed, throw with the collected error messages
    // so the monitoring service records a credential-level error row
    if (sitesById.size === 0 && errors.length > 0) {
      throw new Error(`Tesla Powerhub: all connections failed. ${errors[0]}`);
    }

    return Array.from(sitesById.values());
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string
  ) {
    const connections = parseConnections(credential);
    if (connections.length === 0) {
      return siteIds.map(siteId => ({
        siteId,
        siteName: null,
        status: "Error" as const,
        lifetimeKwh: null,
        errorMessage:
          "Tesla Powerhub setup is missing required values. Save clientId and clientSecret in Solar REC Settings.",
      }));
    }

    // Preload all group sites. Track errors so we can surface them.
    const sitesById = new Map<string, TeslaPowerhubSiteProductionMetrics>();
    let preloadError: string | null = null;
    for (const connection of connections) {
      try {
        const sites = await loadGroupSites(connection, anchorDate);
        sites.forEach(site => {
          if (!sitesById.has(site.siteId)) {
            sitesById.set(site.siteId, site);
          }
        });
      } catch (error) {
        preloadError = error instanceof Error ? error.message : String(error);
        console.error(
          "[Tesla Powerhub adapter] getSnapshots preload error:",
          preloadError
        );
      }
    }

    return siteIds.map(siteId => {
      const site = sitesById.get(siteId);
      if (!site) {
        // If preload failed entirely, report the actual error instead of "Not Found"
        if (preloadError && sitesById.size === 0) {
          return {
            siteId,
            siteName: null,
            status: "Error" as const,
            lifetimeKwh: null,
            errorMessage: preloadError,
          };
        }
        return {
          siteId,
          siteName: null,
          status: "Not Found" as const,
          lifetimeKwh: null,
        };
      }
      const hasReading =
        typeof site.lifetimeKwh === "number" &&
        Number.isFinite(site.lifetimeKwh);
      return {
        siteId,
        siteName: site.siteName ?? site.siteExternalId ?? null,
        status: hasReading ? ("Found" as const) : ("Not Found" as const),
        lifetimeKwh: hasReading ? site.lifetimeKwh : null,
      };
    });
  },
};

export default adapter;
