import {
  listSystems,
  getSystemProductionSnapshot,
  type APsystemsApiContext,
} from "../../services/apsystems";

function getContexts(credential: { accessToken?: string | null; metadata?: string | null }): APsystemsApiContext[] {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      // Multi-connection format: connections[].appId, connections[].appSecret, connections[].baseUrl
      if (meta.connections && Array.isArray(meta.connections)) {
        return meta.connections
          .filter((c: any) => c.appId || c.apiKey)
          .map((c: any) => ({
            appId: c.appId ?? c.apiKey,
            appSecret: c.appSecret ?? "",
            baseUrl: c.baseUrl ?? meta.baseUrl ?? null,
          }));
      }
      // Simple format fallback
      const appId = meta.appId ?? meta.apiKey;
      if (appId) {
        return [{
          appId,
          appSecret: meta.appSecret ?? "",
          baseUrl: meta.baseUrl ?? null,
        }];
      }
    } catch {}
  }
  // accessToken fallback
  if (credential.accessToken) return [{ appId: credential.accessToken, appSecret: "" }];
  return [];
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    const contexts = getContexts(credential);
    if (contexts.length === 0) throw new Error("APsystems requires appId in metadata or accessToken.");
    const allSites: { siteId: string; siteName: string }[] = [];
    for (const ctx of contexts) {
      try {
        const { systems } = await listSystems(ctx);
        allSites.push(...systems.map((s) => ({ siteId: s.systemId, siteName: s.name })));
      } catch (err) {
        console.error(`[APsystems adapter] listSites error:`, err instanceof Error ? err.message : err);
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
        const snap = await getSystemProductionSnapshot(ctx, siteId, anchorDate);
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
