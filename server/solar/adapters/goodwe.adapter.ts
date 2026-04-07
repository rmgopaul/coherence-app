import {
  listStations,
  getStationProductionSnapshot,
  type GoodWeApiContext,
} from "../../services/goodwe";

function parseMetadata(metadata: string | null | undefined): GoodWeApiContext | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.account && parsed.password) {
      return {
        account: parsed.account,
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
    if (!ctx) throw new Error("GoodWe requires account and password in metadata.");
    const { stations } = await listStations(ctx);
    return stations.map((s) => ({ siteId: s.stationId, siteName: s.name }));
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const ctx = parseMetadata(credential.metadata);
    if (!ctx) throw new Error("GoodWe requires account and password in metadata.");
    const results = [];
    for (const siteId of siteIds) {
      try {
        const snap = await getStationProductionSnapshot(ctx, siteId, anchorDate);
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
