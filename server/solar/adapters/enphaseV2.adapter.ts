import {
  listSystems,
  getSystemSummary,
  type EnphaseV2Credentials,
} from "../../services/solar/enphaseV2";
import { asRecord, toNullableNumber } from "../../services/solar/helpers";

/**
 * EnphaseV2 metadata format: apiKey + userId in metadata, no connections array.
 * Similar to enphaseV4's deviation from the multi-connection pattern.
 */
function getContext(credential: { accessToken?: string | null; metadata?: string | null }): EnphaseV2Credentials | null {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      const apiKey = meta.apiKey ?? credential.accessToken;
      const userId = meta.userId;
      if (apiKey && userId) {
        return {
          apiKey,
          userId,
          baseUrl: meta.baseUrl ?? null,
        };
      }
    } catch {}
  }
  return null;
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    const ctx = getContext(credential);
    if (!ctx) throw new Error("Enphase V2 requires apiKey and userId in metadata.");
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
        const raw = await getSystemSummary(ctx, siteId);
        const summary = asRecord(raw);
        const lifetimeWh = toNullableNumber(summary.energy_lifetime ?? summary.energyLifetime);
        const lifetimeKwh = lifetimeWh != null ? Math.round((lifetimeWh / 1000) * 100) / 100 : null;
        results.push({
          siteId,
          siteName: null,
          status: (lifetimeKwh != null ? "Found" : "Not Found") as "Found" | "Not Found",
          lifetimeKwh,
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
