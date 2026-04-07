import {
  listDevices,
  getDeviceProductionSnapshot,
  type SolarLogApiContext,
} from "../../services/solarLog";

function parseMetadata(metadata: string | null | undefined): SolarLogApiContext | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.baseUrl) {
      return {
        baseUrl: parsed.baseUrl,
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
    if (!ctx) throw new Error("Solar-Log requires baseUrl (device IP/hostname) in metadata.");
    const { devices } = await listDevices(ctx);
    return devices.map((d) => ({ siteId: d.deviceId, siteName: d.name }));
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const ctx = parseMetadata(credential.metadata);
    if (!ctx) throw new Error("Solar-Log requires baseUrl (device IP/hostname) in metadata.");
    const results = [];
    for (const siteId of siteIds) {
      try {
        const snap = await getDeviceProductionSnapshot(ctx, siteId, anchorDate);
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
