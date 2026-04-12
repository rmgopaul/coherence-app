import {
  listSites as locusList,
  getSiteProductionSnapshot,
  type LocusApiContext,
} from "../../services/solar/locus";

function getContexts(credential: { accessToken?: string | null; metadata?: string | null }): LocusApiContext[] {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      // Multi-connection format: connections[].clientId, connections[].clientSecret, connections[].partnerId
      if (meta.connections && Array.isArray(meta.connections)) {
        return meta.connections
          .filter((c: any) => c.clientId && c.clientSecret && c.partnerId)
          .map((c: any) => ({
            clientId: c.clientId,
            clientSecret: c.clientSecret,
            partnerId: c.partnerId,
            baseUrl: c.baseUrl ?? meta.baseUrl ?? null,
          }));
      }
      // Simple format fallback
      if (meta.clientId && meta.clientSecret && meta.partnerId) {
        return [{
          clientId: meta.clientId,
          clientSecret: meta.clientSecret,
          partnerId: meta.partnerId,
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
    if (contexts.length === 0) throw new Error("Locus requires clientId, clientSecret, and partnerId in metadata.");
    const allSites: { siteId: string; siteName: string }[] = [];
    for (const ctx of contexts) {
      try {
        const { sites } = await locusList(ctx);
        allSites.push(...sites.map((s) => ({ siteId: s.siteId, siteName: s.name })));
      } catch (err) {
        console.error(`[Locus adapter] listSites error:`, err instanceof Error ? err.message : err);
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
        const snap = await getSiteProductionSnapshot(ctx, siteId, anchorDate);
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
