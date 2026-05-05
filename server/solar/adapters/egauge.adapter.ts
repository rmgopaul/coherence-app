import {
  getEgaugePortfolioSystems,
  getEgaugeSystemInfo,
  getMeterProductionSnapshot,
  type EgaugeApiContext,
  type EgaugeAccessType,
} from "../../services/solar/egauge";

type EgaugeConnection = EgaugeApiContext & {
  meterId?: string | null;
  name?: string | null;
};
type EgaugeSite = { siteId: string; siteName: string };

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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

function deriveMeterIdFromBaseUrl(raw: unknown): string | null {
  const value = normalizeBaseUrl(raw);
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (host === "egauge.net" || host === "www.egauge.net") return null;
    const firstLabel = parsed.hostname.split(".")[0]?.trim();
    return firstLabel && /^[a-z0-9-_.]+$/i.test(firstLabel) ? firstLabel : null;
  } catch {
    return null;
  }
}

function isPortalUrl(raw: unknown): boolean {
  const value = normalizeBaseUrl(raw);
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "egauge.net" || host === "www.egauge.net";
  } catch {
    return false;
  }
}

function inferAccessType(
  explicit: unknown,
  baseUrl: string | null,
  username: string | null,
  password: string | null
): EgaugeAccessType {
  const fromMeta = toNonEmptyString(explicit);
  if (
    fromMeta === "public" ||
    fromMeta === "user_login" ||
    fromMeta === "site_login" ||
    fromMeta === "portfolio_login"
  ) {
    return fromMeta;
  }
  if (username && password && isPortalUrl(baseUrl)) return "portfolio_login";
  if (username && password) return "user_login";
  return "public";
}

function getConnections(credential: {
  accessToken?: string | null;
  metadata?: string | null;
}): EgaugeConnection[] {
  const fallbackBaseUrl = normalizeBaseUrl(credential.accessToken);
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      if (meta.connections && Array.isArray(meta.connections)) {
        type EgaugeRawConnection = {
          username?: string;
          password?: string;
          baseUrl?: string;
          deviceUrl?: string;
          meterId?: string;
          accessType?: string;
          name?: string;
        };
        return meta.connections
          .map((c: EgaugeRawConnection) => {
            const username = toNonEmptyString(c.username ?? meta.username);
            const password = toNonEmptyString(
              c.password ?? meta.password ?? credential.accessToken
            );
            const baseUrl =
              normalizeBaseUrl(c.baseUrl) ??
              normalizeBaseUrl(c.deviceUrl) ??
              buildMeterUrlFromId(c.meterId) ??
              normalizeBaseUrl(meta.baseUrl) ??
              normalizeBaseUrl(meta.deviceUrl) ??
              buildMeterUrlFromId(meta.meterId) ??
              buildMeterUrlFromConnectionName(meta.connectionName) ??
              fallbackBaseUrl;
            const meterId =
              toNonEmptyString(c.meterId ?? meta.meterId) ??
              deriveMeterIdFromBaseUrl(baseUrl);
            return {
              baseUrl,
              accessType: inferAccessType(
                c.accessType ?? meta.accessType,
                baseUrl,
                username,
                password
              ),
              username,
              password,
              meterId,
              name: toNonEmptyString(c.name ?? meta.name),
            };
          })
          .filter((connection: { baseUrl: string | null }) =>
            Boolean(connection.baseUrl)
          );
      }
      const username = toNonEmptyString(meta.username);
      const password = toNonEmptyString(
        meta.password ?? credential.accessToken
      );
      const baseUrl =
        normalizeBaseUrl(meta.baseUrl) ??
        normalizeBaseUrl(meta.deviceUrl) ??
        buildMeterUrlFromId(meta.meterId) ??
        buildMeterUrlFromConnectionName(meta.connectionName) ??
        fallbackBaseUrl;
      if (baseUrl) {
        const meterId =
          toNonEmptyString(meta.meterId) ?? deriveMeterIdFromBaseUrl(baseUrl);
        return [
          {
            baseUrl,
            accessType: inferAccessType(
              meta.accessType,
              baseUrl,
              username,
              password
            ),
            username,
            password,
            meterId,
            name: toNonEmptyString(meta.name),
          },
        ];
      }
    } catch {}
  }
  if (fallbackBaseUrl) {
    return [{ baseUrl: fallbackBaseUrl }];
  }
  return [];
}

function addSiteDeduped(
  sites: EgaugeSite[],
  seen: Set<string>,
  site: EgaugeSite
): void {
  const key = site.siteId.trim().toLowerCase();
  if (!key || seen.has(key)) return;
  seen.add(key);
  sites.push(site);
}

const adapter = {
  async listSites(credential: {
    accessToken?: string | null;
    metadata?: string | null;
  }) {
    const conns = getConnections(credential);
    if (conns.length === 0)
      throw new Error("eGauge requires baseUrl (meter URL) in metadata.");
    const allSites: EgaugeSite[] = [];
    const seen = new Set<string>();
    const errors: string[] = [];
    for (const conn of conns) {
      try {
        if (conn.accessType === "portfolio_login") {
          const portfolio = await getEgaugePortfolioSystems(conn);
          for (const row of portfolio.rows) {
            addSiteDeduped(allSites, seen, {
              siteId: row.meterId,
              siteName: row.meterName ?? row.siteName ?? row.meterId,
            });
          }
          continue;
        }
        const info = await getEgaugeSystemInfo(conn);
        const meterId =
          conn.meterId ??
          info.serialNumber ??
          deriveMeterIdFromBaseUrl(info.baseUrl) ??
          info.baseUrl;
        const meterName = conn.name ?? info.systemName ?? meterId;
        addSiteDeduped(allSites, seen, {
          siteId: meterId,
          siteName: meterName,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        console.error(`[eGauge adapter] listSites error:`, message);
      }
    }
    if (allSites.length === 0 && errors.length > 0) {
      throw new Error(`eGauge site discovery failed: ${errors.join(" | ")}`);
    }
    return allSites;
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string
  ) {
    const conns = getConnections(credential);
    if (conns.length === 0) {
      return siteIds.map(id => ({
        siteId: id,
        siteName: null,
        status: "Error" as const,
        lifetimeKwh: null,
        errorMessage: "No eGauge credentials configured.",
      }));
    }

    const resultsBySiteId = new Map<
      string,
      {
        siteId: string;
        siteName: string | null;
        status: "Found" | "Not Found" | "Error";
        lifetimeKwh: number | null;
        errorMessage?: string;
      }
    >();
    const remaining = new Set(siteIds);
    const portfolioErrors: string[] = [];

    for (const conn of conns.filter(c => c.accessType === "portfolio_login")) {
      try {
        const portfolio = await getEgaugePortfolioSystems(conn, { anchorDate });
        const byMeterId = new Map(
          portfolio.rows.map(row => [row.meterId.trim().toLowerCase(), row])
        );
        for (const siteId of Array.from(remaining)) {
          const row = byMeterId.get(siteId.trim().toLowerCase());
          if (!row) continue;
          resultsBySiteId.set(siteId, {
            siteId,
            siteName: row.meterName ?? row.siteName ?? null,
            status: row.status,
            lifetimeKwh: row.lifetimeKwh ?? null,
            errorMessage: row.error ?? undefined,
          });
          remaining.delete(siteId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        portfolioErrors.push(message);
        console.error(
          `[eGauge adapter] portfolio getSnapshots error:`,
          message
        );
      }
    }

    const siteToConn = new Map<string, EgaugeConnection>();
    const nonPortfolioConns = conns.filter(
      c => c.accessType !== "portfolio_login"
    );
    for (const conn of nonPortfolioConns) {
      const candidates = [
        conn.meterId,
        conn.baseUrl,
        conn.name,
        deriveMeterIdFromBaseUrl(conn.baseUrl),
      ].filter((v): v is string => v != null);
      for (const candidate of candidates) {
        if (!siteToConn.has(candidate)) {
          siteToConn.set(candidate, conn);
        }
      }
    }

    for (const siteId of Array.from(remaining)) {
      if (nonPortfolioConns.length === 0 && portfolioErrors.length > 0) {
        resultsBySiteId.set(siteId, {
          siteId,
          siteName: null,
          status: "Error",
          lifetimeKwh: null,
          errorMessage: `eGauge portfolio snapshot failed: ${portfolioErrors.join(" | ")}`,
        });
        continue;
      }
      const ctx =
        siteToConn.get(siteId) ??
        (nonPortfolioConns.length === 1 ? nonPortfolioConns[0] : undefined);
      if (!ctx) {
        resultsBySiteId.set(siteId, {
          siteId,
          siteName: null,
          status: "Not Found",
          lifetimeKwh: null,
          errorMessage: `No eGauge credential matched site "${siteId}".`,
        });
        continue;
      }
      try {
        const snap = await getMeterProductionSnapshot(
          ctx,
          siteId,
          null,
          anchorDate
        );
        resultsBySiteId.set(siteId, {
          siteId,
          siteName: snap.meterName ?? null,
          status: snap.status as "Found" | "Not Found" | "Error",
          lifetimeKwh: snap.lifetimeKwh ?? null,
          errorMessage: snap.error ?? undefined,
        });
      } catch (err) {
        resultsBySiteId.set(siteId, {
          siteId,
          siteName: null,
          status: "Error" as const,
          lifetimeKwh: null,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return siteIds.map(
      siteId =>
        resultsBySiteId.get(siteId) ?? {
          siteId,
          siteName: null,
          status: "Not Found" as const,
          lifetimeKwh: null,
          errorMessage: `eGauge site "${siteId}" was not returned by any configured profile.`,
        }
    );
  },
};

export default adapter;
