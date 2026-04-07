import {
  listSystems,
  getSystemProductionSnapshot,
  type GeneracApiContext,
} from "../../services/generac";

function parseMetadata(metadata: string | null | undefined): GeneracApiContext | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.apiKey) {
      return {
        apiKey: parsed.apiKey,
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
    const ctx = parseMetadata(credential.metadata) ?? { apiKey: credential.accessToken ?? "" };
    const { systems } = await listSystems(ctx);
    return systems.map((s) => ({ siteId: s.systemId, siteName: s.name }));
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const ctx = parseMetadata(credential.metadata) ?? { apiKey: credential.accessToken ?? "" };
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
