import {
  listSites as locusList,
  getSiteProductionSnapshot,
  type LocusApiContext,
} from "../../services/locus";

function parseMetadata(metadata: string | null | undefined): LocusApiContext | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.clientId && parsed.clientSecret && parsed.partnerId) {
      return {
        clientId: parsed.clientId,
        clientSecret: parsed.clientSecret,
        partnerId: parsed.partnerId,
        baseUrl: parsed.baseUrl ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    const ctx = parseMetadata(credential.metadata);
    if (!ctx) throw new Error("Locus requires clientId, clientSecret, and partnerId in metadata.");
    const { sites } = await locusList(ctx);
    return sites.map((s) => ({ siteId: s.siteId, siteName: s.name }));
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const ctx = parseMetadata(credential.metadata);
    if (!ctx) throw new Error("Locus requires clientId, clientSecret, and partnerId in metadata.");
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
