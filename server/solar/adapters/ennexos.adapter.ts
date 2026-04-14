import {
  listPlants,
  getPlantProductionSnapshot,
  type EnnexOsApiContext,
} from "../../services/solar/ennexos";

function getContext(credential: { accessToken?: string | null; metadata?: string | null }): EnnexOsApiContext | null {
  const accessToken = credential.accessToken?.trim();
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      const token = meta.accessToken?.trim() ?? accessToken;
      if (token) {
        return {
          accessToken: token,
          baseUrl: meta.baseUrl ?? null,
        };
      }
    } catch {}
  }
  if (accessToken) return { accessToken };
  return null;
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    const ctx = getContext(credential);
    if (!ctx) throw new Error("eNNexOS requires an accessToken.");
    const { plants } = await listPlants(ctx);
    return plants.map((p) => ({ siteId: p.plantId, siteName: p.name }));
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
        const snap = await getPlantProductionSnapshot(ctx, siteId, anchorDate);
        results.push({
          siteId,
          siteName: snap.plantId ? null : null,
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
