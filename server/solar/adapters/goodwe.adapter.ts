import {
  listStations,
  getStationProductionSnapshot,
  type GoodWeApiContext,
} from "../../services/solar/goodwe";

function getContexts(credential: { accessToken?: string | null; metadata?: string | null }): GoodWeApiContext[] {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      // Multi-connection format: connections[].account (or username), connections[].password
      if (meta.connections && Array.isArray(meta.connections)) {
        return meta.connections
          .filter((c: any) => (c.account || c.username) && c.password)
          .map((c: any) => ({
            account: c.account ?? c.username,
            password: c.password,
            baseUrl: c.baseUrl ?? meta.baseUrl ?? null,
          }));
      }
      // Simple format fallback
      if (meta.account && meta.password) {
        return [{
          account: meta.account,
          password: meta.password,
          baseUrl: meta.baseUrl ?? null,
        }];
      }
    } catch {}
  }
  return [];
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    const contexts = getContexts(credential);
    if (contexts.length === 0) throw new Error("GoodWe requires account and password in metadata.");
    const allSites: { siteId: string; siteName: string }[] = [];
    for (const ctx of contexts) {
      try {
        const { stations } = await listStations(ctx);
        allSites.push(...stations.map((s) => ({ siteId: s.stationId, siteName: s.name })));
      } catch (err) {
        console.error(`[GoodWe adapter] listSites error:`, err instanceof Error ? err.message : err);
      }
    }
    return allSites;
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const contexts = getContexts(credential);
    const ctx = contexts[0];
    if (!ctx) return siteIds.map((id) => ({ siteId: id, siteName: null, status: "Error" as const, lifetimeKwh: null, errorMessage: "No credentials" }));
    const results = [];
    for (const siteId of siteIds) {
      try {
        const snap = await getStationProductionSnapshot(ctx, siteId, anchorDate);
        results.push({
          siteId,
          siteName: snap.name ?? null,
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
