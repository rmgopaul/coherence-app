import {
  listPvSystems,
  getPvSystemProductionSnapshot,
  type FroniusApiContext,
} from "../../services/fronius";

function parseMetadata(metadata: string | null | undefined): FroniusApiContext | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.accessKeyId && parsed.accessKeyValue) {
      return {
        accessKeyId: parsed.accessKeyId,
        accessKeyValue: parsed.accessKeyValue,
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
    if (!ctx) throw new Error("Fronius requires accessKeyId and accessKeyValue in metadata.");
    const { pvSystems } = await listPvSystems(ctx);
    return pvSystems.map((s) => ({ siteId: s.pvSystemId, siteName: s.name }));
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const ctx = parseMetadata(credential.metadata);
    if (!ctx) throw new Error("Fronius requires accessKeyId and accessKeyValue in metadata.");
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
