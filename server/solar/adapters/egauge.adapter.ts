import {
  getEgaugeSystemInfo,
  getMeterProductionSnapshot,
  type EgaugeApiContext,
} from "../../services/egauge";

type EgaugeConnection = EgaugeApiContext & { meterId?: string | null; name?: string | null };

function getConnections(credential: { accessToken?: string | null; metadata?: string | null }): EgaugeConnection[] {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      if (meta.connections && Array.isArray(meta.connections)) {
        return meta.connections
          .filter((c: any) => c.baseUrl)
          .map((c: any) => ({
            baseUrl: c.baseUrl,
            accessType: c.accessType ?? null,
            username: c.username ?? null,
            password: c.password ?? null,
            meterId: c.meterId ?? null,
            name: c.name ?? null,
          }));
      }
      if (meta.baseUrl) {
        return [{
          baseUrl: meta.baseUrl,
          accessType: meta.accessType ?? null,
          username: meta.username ?? null,
          password: meta.password ?? null,
          meterId: meta.meterId ?? null,
          name: meta.name ?? null,
        }];
      }
    } catch {}
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
    const ctx = conns[0];
    if (!ctx) return siteIds.map((id) => ({ siteId: id, siteName: null, status: "Error" as const, lifetimeKwh: null, errorMessage: "No credentials" }));
    const results = [];
    for (const siteId of siteIds) {
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
