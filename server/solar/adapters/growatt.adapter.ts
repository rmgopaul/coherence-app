import {
  listPlants,
  getPlantProductionSnapshot,
  type GrowattApiContext,
} from "../../services/growatt";

function parseMetadata(metadata: string | null | undefined): GrowattApiContext | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.username && parsed.password) {
      return {
        username: parsed.username,
        password: parsed.password,
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
    if (!ctx) throw new Error("Growatt requires username and password in metadata.");
    const { plants } = await listPlants(ctx);
    return plants.map((p) => ({ siteId: p.plantId, siteName: p.name }));
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const ctx = parseMetadata(credential.metadata);
    if (!ctx) throw new Error("Growatt requires username and password in metadata.");
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
