import {
  listSystems,
  getSystemProductionSnapshot,
  type APsystemsApiContext,
} from "../../services/apsystems";

function parseMetadata(metadata: string | null | undefined): APsystemsApiContext | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    const appId = parsed.appId ?? parsed.apiKey;
    const appSecret = parsed.appSecret ?? "";
    if (appId) {
      return {
        appId,
        appSecret,
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
    const ctx = parseMetadata(credential.metadata) ?? { appId: credential.accessToken ?? "", appSecret: "" };
    const { systems } = await listSystems(ctx);
    return systems.map((s) => ({ siteId: s.systemId, siteName: s.name }));
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const ctx = parseMetadata(credential.metadata) ?? { appId: credential.accessToken ?? "", appSecret: "" };
    const results = [];
    for (const siteId of siteIds) {
      try {
        const snap = await getSystemProductionSnapshot(ctx, siteId, anchorDate);
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
