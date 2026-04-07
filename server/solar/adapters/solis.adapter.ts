import {
  listStations,
  getStationProductionSnapshot,
  type SolisApiContext,
} from "../../services/solis";

function parseMetadata(metadata: string | null | undefined): SolisApiContext | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.apiKey && parsed.apiSecret) {
      return {
        apiKey: parsed.apiKey,
        apiSecret: parsed.apiSecret,
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
    if (!ctx) throw new Error("Solis requires apiKey and apiSecret in metadata.");
    const { stations } = await listStations(ctx);
    return stations.map((s) => ({ siteId: s.stationId, siteName: s.name }));
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const ctx = parseMetadata(credential.metadata);
    if (!ctx) throw new Error("Solis requires apiKey and apiSecret in metadata.");
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
