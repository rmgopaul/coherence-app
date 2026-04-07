import {
  getEgaugeSystemInfo,
  getMeterProductionSnapshot,
  type EgaugeApiContext,
} from "../../services/egauge";

function parseMetadata(metadata: string | null | undefined): EgaugeApiContext | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.baseUrl) {
      return {
        baseUrl: parsed.baseUrl,
        accessType: parsed.accessType ?? null,
        username: parsed.username ?? null,
        password: parsed.password ?? null,
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
    if (!ctx) throw new Error("eGauge requires baseUrl (meter URL) in metadata.");
    const info = await getEgaugeSystemInfo(ctx);
    const meterId = info.serialNumber ?? info.baseUrl;
    const meterName = info.systemName ?? "eGauge Meter";
    return [{ siteId: meterId, siteName: meterName }];
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const ctx = parseMetadata(credential.metadata);
    if (!ctx) throw new Error("eGauge requires baseUrl (meter URL) in metadata.");
    const results = [];
    for (const siteId of siteIds) {
      try {
        const snap = await getMeterProductionSnapshot(ctx, siteId, null, anchorDate);
        results.push({
          siteId,
          siteName: snap.meterName ?? null,
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
