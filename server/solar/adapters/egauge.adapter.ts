/**
 * eGauge monitoring adapter.
 *
 * Key fix: auto-detects accessType from username/password presence.
 * Without this, portfolio-login meters default to "public" access and
 * the digest auth handshake is silently skipped, causing 401 errors.
 *
 * Also fixes multi-connection getSnapshots — each site is queried
 * using the connection that discovered it, not just conns[0].
 */
import {
  getEgaugeSystemInfo,
  getMeterProductionSnapshot,
  type EgaugeApiContext,
  type EgaugeAccessType,
} from "../../services/solar/egauge";

type EgaugeConnection = EgaugeApiContext & { meterId?: string | null; name?: string | null };

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBaseUrl(raw: unknown): string | null {
  const value = toNonEmptyString(raw);
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function buildMeterUrlFromId(rawMeterId: unknown): string | null {
  const meterId = toNonEmptyString(rawMeterId);
  if (!meterId) return null;
  return `https://${meterId}.d.egauge.net`;
}

function buildMeterUrlFromConnectionName(raw: unknown): string | null {
  const value = toNonEmptyString(raw);
  if (!value) return null;
  if (!/^[a-z0-9-_.]+$/i.test(value)) return null;
  if (value.includes(" ")) return null;
  return `https://${value}.d.egauge.net`;
}

/**
 * If accessType is not explicitly set but username+password are present,
 * default to "portfolio_login" so the digest auth handshake fires.
 */
function inferAccessType(
  explicit: unknown,
  username: string | null,
  password: string | null
): EgaugeAccessType | null {
  const fromMeta = toNonEmptyString(explicit);
  if (fromMeta === "public" || fromMeta === "user_login" || fromMeta === "site_login" || fromMeta === "portfolio_login") {
    return fromMeta;
  }
  if (username && password) return "portfolio_login";
  return null;
}

function getConnections(credential: { accessToken?: string | null; metadata?: string | null }): EgaugeConnection[] {
  const fallbackBaseUrl = normalizeBaseUrl(credential.accessToken);
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      if (meta.connections && Array.isArray(meta.connections)) {
        return meta.connections
          .map((c: any) => {
            const username = toNonEmptyString(c.username ?? meta.username);
            const password = toNonEmptyString(c.password ?? meta.password);
            return {
              baseUrl:
                normalizeBaseUrl(c.baseUrl) ??
                normalizeBaseUrl(c.deviceUrl) ??
                buildMeterUrlFromId(c.meterId) ??
                normalizeBaseUrl(meta.baseUrl) ??
                normalizeBaseUrl(meta.deviceUrl) ??
                buildMeterUrlFromId(meta.meterId) ??
                buildMeterUrlFromConnectionName(meta.connectionName) ??
                fallbackBaseUrl,
              accessType: inferAccessType(c.accessType ?? meta.accessType, username, password),
              username,
              password,
              meterId: toNonEmptyString(c.meterId ?? meta.meterId),
              name: toNonEmptyString(c.name ?? meta.name),
            };
          })
          .filter((connection: { baseUrl: string | null }) => Boolean(connection.baseUrl));
      }
      const username = toNonEmptyString(meta.username);
      const password = toNonEmptyString(meta.password);
      const baseUrl =
        normalizeBaseUrl(meta.baseUrl) ??
        normalizeBaseUrl(meta.deviceUrl) ??
        buildMeterUrlFromId(meta.meterId) ??
        buildMeterUrlFromConnectionName(meta.connectionName) ??
        fallbackBaseUrl;
      if (baseUrl) {
        return [{
          baseUrl,
          accessType: inferAccessType(meta.accessType, username, password),
          username,
          password,
          meterId: toNonEmptyString(meta.meterId),
          name: toNonEmptyString(meta.name),
        }];
      }
    } catch {}
  }
  if (fallbackBaseUrl) {
    return [{ baseUrl: fallbackBaseUrl }];
  }
  return [];
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    const conns = getConnections(credential);
    if (conns.length === 0) throw new Error("eGauge requires baseUrl (meter URL) in metadata.");
    const allSites: { siteId: string; siteName: string }[] = [];
    for (const conn of conns) {
      try {
        const info = await getEgaugeSystemInfo(conn);
        const meterId = conn.meterId ?? info.serialNumber ?? info.baseUrl;
        const meterName = conn.name ?? info.systemName ?? "eGauge Meter";
        allSites.push({ siteId: meterId, siteName: meterName });
      } catch (err) {
        console.error(`[eGauge adapter] listSites error:`, err instanceof Error ? err.message : err);
      }
    }
    return allSites;
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const conns = getConnections(credential);
    if (conns.length === 0) {
      return siteIds.map((id) => ({
        siteId: id,
        siteName: null,
        status: "Error" as const,
        lifetimeKwh: null,
        errorMessage: "No eGauge credentials configured.",
      }));
    }

    // Build a lookup: siteId → connection that should serve it.
    // For single-connection credentials this is trivial.
    // For multi-connection: each connection's baseUrl (or meterId) maps to a siteId.
    const siteToConn = new Map<string, EgaugeConnection>();
    for (const conn of conns) {
      // The siteId returned by listSites is: conn.meterId ?? info.serialNumber ?? info.baseUrl
      // We map all possible identifiers for this connection so getSnapshots finds a match.
      const candidates = [
        conn.meterId,
        conn.baseUrl,
        conn.name,
      ].filter((v): v is string => v != null);
      for (const candidate of candidates) {
        if (!siteToConn.has(candidate)) {
          siteToConn.set(candidate, conn);
        }
      }
    }

    const results = [];
    for (const siteId of siteIds) {
      // Pick the connection that owns this site, fall back to first connection
      const ctx = siteToConn.get(siteId) ?? conns[0];
      try {
        const snap = await getMeterProductionSnapshot(ctx, siteId, null, anchorDate);
        results.push({
          siteId,
          siteName: snap.meterName ?? null,
          status: snap.status as "Found" | "Not Found" | "Error",
          lifetimeKwh: snap.lifetimeKwh ?? null,
        });
      } catch (err) {
        results.push({
          siteId,
          siteName: null,
          status: "Error" as const,
          lifetimeKwh: null,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  },
};

export default adapter;
