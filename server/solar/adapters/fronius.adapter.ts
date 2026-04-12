import {
  listPvSystems,
  getPvSystemProductionSnapshot,
  type FroniusApiContext,
} from "../../services/solar/fronius";

function getContexts(credential: { accessToken?: string | null; metadata?: string | null }): FroniusApiContext[] {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      // Multi-connection format: connections[].accessKeyId, connections[].accessKeyValue
      if (meta.connections && Array.isArray(meta.connections)) {
        return meta.connections
          .filter((c: any) => c.accessKeyId && c.accessKeyValue)
          .map((c: any) => ({
            accessKeyId: c.accessKeyId,
            accessKeyValue: c.accessKeyValue,
            baseUrl: c.baseUrl ?? meta.baseUrl ?? null,
          }));
      }
      // Simple format fallback
      if (meta.accessKeyId && meta.accessKeyValue) {
        return [{
          accessKeyId: meta.accessKeyId,
          accessKeyValue: meta.accessKeyValue,
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
    if (contexts.length === 0) throw new Error("Fronius requires accessKeyId and accessKeyValue in metadata.");
    const allSites: { siteId: string; siteName: string }[] = [];
    for (const ctx of contexts) {
      try {
        const { pvSystems } = await listPvSystems(ctx);
        allSites.push(...pvSystems.map((s) => ({ siteId: s.pvSystemId, siteName: s.name })));
      } catch (err) {
        console.error(`[Fronius adapter] listSites error:`, err instanceof Error ? err.message : err);
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
        const snap = await getPvSystemProductionSnapshot(ctx, siteId, anchorDate);
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
