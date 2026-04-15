import {
  listPvSystems,
  getPvSystemProductionSnapshot,
  type FroniusApiContext,
} from "../../services/solar/fronius";
import { mapWithConcurrency } from "../../services/core/concurrency";

function getContexts(credential: { accessToken?: string | null; metadata?: string | null }): FroniusApiContext[] {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      // Multi-connection format: connections[].accessKeyId, connections[].accessKeyValue
      if (meta.connections && Array.isArray(meta.connections)) {
        type FroniusConnection = {
          accessKeyId?: string;
          accessKeyValue?: string;
          baseUrl?: string | null;
        };
        return meta.connections
          .filter((c: FroniusConnection) => c.accessKeyId && c.accessKeyValue)
          .map((c: FroniusConnection) => ({
            accessKeyId: c.accessKeyId as string,
            accessKeyValue: c.accessKeyValue as string,
            baseUrl: c.baseUrl ?? meta.baseUrl ?? null,
          }));
      }
      // Simple format fallback
      if (meta.accessKeyId && meta.accessKeyValue) {
        return [{
          accessKeyId: meta.accessKeyId,
          accessKeyValue: meta.accessKeyValue,
          baseUrl: meta.baseUrl ?? null,
        }];
      }
    } catch {}
  }
  return [];
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    const contexts = getContexts(credential);
    if (contexts.length === 0) throw new Error("Fronius requires accessKeyId and accessKeyValue in metadata.");
    const allSites: { siteId: string; siteName: string }[] = [];
    const errors: string[] = [];
    for (const ctx of contexts) {
      try {
        const { pvSystems } = await listPvSystems(ctx);
        allSites.push(...pvSystems.map((s) => ({ siteId: s.pvSystemId, siteName: s.name })));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Fronius adapter] listSites error:`, msg);
        errors.push(msg);
      }
    }
    if (allSites.length === 0 && errors.length > 0) {
      throw new Error(`All Fronius connections failed: ${errors.join("; ")}`);
    }
    return allSites;
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const contexts = getContexts(credential);
    if (contexts.length === 0) {
      return siteIds.map((id) => ({
        siteId: id,
        siteName: null,
        status: "Error" as const,
        lifetimeKwh: null,
        errorMessage: "No credentials",
      }));
    }

    return mapWithConcurrency(siteIds, 4, async (siteId) => {
      let lastError: string | null = null;

      for (const ctx of contexts) {
        try {
          const snap = await getPvSystemProductionSnapshot(ctx, siteId, anchorDate);

          if (snap.status === "Found") {
            return {
              siteId,
              siteName: snap.name ?? null,
              status: "Found" as const,
              lifetimeKwh: snap.lifetimeKwh ?? null,
            };
          }

          // "Not Found" — site may belong to a different connection
          if (snap.status === "Not Found") continue;

          // "Error" — record but try remaining connections
          lastError = snap.error ?? "Unknown API error";
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      // All connections exhausted
      return {
        siteId,
        siteName: null,
        status: (lastError ? "Error" : "Not Found") as "Error" | "Not Found",
        lifetimeKwh: null,
        errorMessage: lastError ?? "Site not found in any connection",
      };
    });
  },
};

export default adapter;
