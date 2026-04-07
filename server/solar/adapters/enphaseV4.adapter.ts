import {
  listSystems,
  getSystemProductionSnapshot,
  type EnphaseV4ApiContext,
} from "../../services/enphaseV4";

/**
 * EnphaseV4 metadata format is different from other providers:
 * - metadata has `userId` and `baseUrl` at top level (no connections array)
 * - accessToken at the credential level is the API key
 */
function getContext(credential: { accessToken?: string | null; metadata?: string | null }): EnphaseV4ApiContext | null {
  const apiKey = credential.accessToken ?? "";
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      // EnphaseV4 uses top-level userId/baseUrl, accessToken is the API key
      if (meta.userId || meta.baseUrl || apiKey) {
        return {
          accessToken: apiKey,
          apiKey: meta.apiKey ?? apiKey,
          baseUrl: meta.baseUrl ?? null,
        };
      }
      // Legacy format: accessToken and apiKey in metadata
      if (meta.accessToken && meta.apiKey) {
        return {
          accessToken: meta.accessToken,
          apiKey: meta.apiKey,
          baseUrl: meta.baseUrl ?? null,
        };
      }
    } catch {}
  }
  // Fallback: just use accessToken as the API key
  if (apiKey) return { accessToken: apiKey, apiKey: "" };
  return null;
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    const ctx = getContext(credential);
    if (!ctx) throw new Error("EnphaseV4 requires an accessToken (API key).");
    const { systems } = await listSystems(ctx);
    return systems.map((s) => ({ siteId: s.systemId, siteName: s.systemName }));
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const ctx = getContext(credential);
    if (!ctx) return siteIds.map((id) => ({ siteId: id, siteName: null, status: "Error" as const, lifetimeKwh: null, errorMessage: "No credentials" }));
    const results = [];
    for (const siteId of siteIds) {
      try {
        const snap = await getSystemProductionSnapshot(ctx, siteId, anchorDate, null);
        results.push({
          siteId,
          siteName: snap.systemName ?? null,
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
