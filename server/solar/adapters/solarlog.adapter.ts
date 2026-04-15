import {
  listDevices,
  getDeviceProductionSnapshot,
  type SolarLogApiContext,
} from "../../services/solar/solarLog";

function getContexts(credential: { accessToken?: string | null; metadata?: string | null }): SolarLogApiContext[] {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      // Multi-connection format: connections[].baseUrl (deviceUrl), connections[].password
      if (meta.connections && Array.isArray(meta.connections)) {
        type SolarLogConnection = {
          baseUrl?: string;
          deviceUrl?: string;
          password?: string | null;
        };
        return meta.connections
          .filter((c: SolarLogConnection) => c.baseUrl || c.deviceUrl)
          .map((c: SolarLogConnection) => ({
            baseUrl: (c.baseUrl ?? c.deviceUrl) as string,
            password: c.password ?? null,
          }));
      }
      // Simple format fallback
      if (meta.baseUrl) {
        return [{
          baseUrl: meta.baseUrl,
          password: meta.password ?? null,
        }];
      }
    } catch {}
  }
  return [];
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    const contexts = getContexts(credential);
    if (contexts.length === 0) throw new Error("Solar-Log requires baseUrl (device IP/hostname) in metadata.");
    const allSites: { siteId: string; siteName: string }[] = [];
    for (const ctx of contexts) {
      try {
        const { devices } = await listDevices(ctx);
        allSites.push(...devices.map((d) => ({ siteId: d.deviceId, siteName: d.name })));
      } catch (err) {
        console.error(`[Solar-Log adapter] listSites error:`, err instanceof Error ? err.message : err);
      }
    }
    return allSites;
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const contexts = getContexts(credential);
    const ctx = contexts[0];
    if (!ctx) return siteIds.map((id) => ({ siteId: id, siteName: null, status: "Error" as const, lifetimeKwh: null, errorMessage: "No credentials" }));
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
