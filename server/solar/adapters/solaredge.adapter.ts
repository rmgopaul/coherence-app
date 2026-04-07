/**
 * SolarEdge monitoring adapter.
 *
 * Wraps server/services/solarEdge.ts functions to conform to the
 * ProviderAdapter interface used by the monitoring batch runner.
 */
import {
  listSites as seListSites,
  getSiteProductionSnapshot,
  type SolarEdgeApiContext,
} from "../../services/solarEdge";

function parseMetadata(metadata: string | null | undefined): SolarEdgeApiContext | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.apiKey) return { apiKey: parsed.apiKey, baseUrl: parsed.baseUrl ?? null };
    return null;
  } catch {
    return null;
  }
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    // SolarEdge uses apiKey from metadata
    const ctx = parseMetadata(credential.metadata) ?? { apiKey: credential.accessToken ?? "" };
    const { sites } = await seListSites(ctx);
    return sites.map((s) => ({
      siteId: s.siteId,
      siteName: s.siteName,
    }));
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string
  ) {
    const ctx = parseMetadata(credential.metadata) ?? { apiKey: credential.accessToken ?? "" };
    const results = [];
    for (const siteId of siteIds) {
      try {
        const snap = await getSiteProductionSnapshot(ctx, siteId, anchorDate);
        results.push({
          siteId,
          siteName: snap.siteName ?? null,
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
