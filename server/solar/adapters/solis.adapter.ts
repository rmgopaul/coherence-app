import {
  listStations,
  getStationProductionSnapshot,
  type SolisApiContext,
} from "../../services/solar/solis";

function getContexts(credential: { accessToken?: string | null; metadata?: string | null }): SolisApiContext[] {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      // Multi-connection format: connections[].apiKey, connections[].apiSecret
      if (meta.connections && Array.isArray(meta.connections)) {
        return meta.connections
          .filter((c: any) => c.apiKey && c.apiSecret)
          .map((c: any) => ({
            apiKey: c.apiKey,
            apiSecret: c.apiSecret,
            baseUrl: c.baseUrl ?? meta.baseUrl ?? null,
          }));
      }
      // Simple format fallback
      if (meta.apiKey && meta.apiSecret) {
        return [{
          apiKey: meta.apiKey,
          apiSecret: meta.apiSecret,
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
    if (contexts.length === 0) throw new Error("Solis requires apiKey and apiSecret in metadata.");
    const allSites: { siteId: string; siteName: string }[] = [];
    for (const ctx of contexts) {
      try {
        const { stations } = await listStations(ctx);
        allSites.push(...stations.map((s) => ({ siteId: s.stationId, siteName: s.name })));
      } catch (err) {
        console.error(`[Solis adapter] listSites error:`, err instanceof Error ? err.message : err);
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
