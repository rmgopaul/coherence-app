import {
  listPlants,
  getPlantProductionSnapshot,
  type GrowattApiContext,
} from "../../services/solar/growatt";

function getContexts(credential: { accessToken?: string | null; metadata?: string | null }): GrowattApiContext[] {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      // Multi-connection format: connections[].username, connections[].password
      if (meta.connections && Array.isArray(meta.connections)) {
        return meta.connections
          .filter((c: any) => c.username && c.password)
          .map((c: any) => ({
            username: c.username,
            password: c.password,
            baseUrl: c.baseUrl ?? meta.baseUrl ?? null,
          }));
      }
      // Simple format fallback
      if (meta.username && meta.password) {
        return [{
          username: meta.username,
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
    if (contexts.length === 0) throw new Error("Growatt requires username and password in metadata.");
    const allSites: { siteId: string; siteName: string }[] = [];
    for (const ctx of contexts) {
      try {
        const { plants } = await listPlants(ctx);
        allSites.push(...plants.map((p) => ({ siteId: p.plantId, siteName: p.name })));
      } catch (err) {
        console.error(`[Growatt adapter] listSites error:`, err instanceof Error ? err.message : err);
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
        const snap = await getPlantProductionSnapshot(ctx, siteId, anchorDate);
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
