import {
  listTeslaProducts,
  getTeslaEnergySiteLiveStatus,
  type TeslaSolarApiContext,
} from "../../services/solar/teslaSolar";
import { asRecord, toNullableNumber } from "../../services/solar/helpers";

function getContext(credential: { accessToken?: string | null; metadata?: string | null }): TeslaSolarApiContext | null {
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
    if (!ctx) throw new Error("Tesla Solar requires an accessToken.");
    const { energySites } = await listTeslaProducts(ctx);
    return energySites.map((s) => ({ siteId: s.siteId, siteName: s.siteName }));
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
        const raw = await getTeslaEnergySiteLiveStatus(ctx, siteId);
        const root = asRecord(raw);
        const response = asRecord(root.response ?? root);
        // Tesla live status returns energy values in watts; lifetime typically not available
        // from live_status, so we check for solar_power as proof of site activity
        const solarPowerW = toNullableNumber(response.solar_power);
        const found = solarPowerW != null;
        results.push({
          siteId,
          siteName: null,
          status: (found ? "Found" : "Not Found") as "Found" | "Not Found",
          lifetimeKwh: null,
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
