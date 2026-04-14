/**
 * SolarEdge monitoring adapter.
 *
 * Site discovery: tries the SolarEdge /sites/list API first. If the API
 * returns 0 sites (common with single-site API keys), falls back to
 * metadata.siteIds — an array of { siteId, name } persisted via the
 * "Upload Site IDs" CSV flow on the monitoring dashboard.
 */
import {
  listSites as seListSites,
  getSiteProductionSnapshot,
  type SolarEdgeApiContext,
} from "../../services/solar/solarEdge";

type StoredSite = { siteId: string; name?: string | null };

function getContexts(credential: { accessToken?: string | null; metadata?: string | null }): SolarEdgeApiContext[] {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      // Multi-connection format: connections[].apiKey
      if (meta.connections && Array.isArray(meta.connections)) {
        return meta.connections
          .filter((c: any) => c.apiKey)
          .map((c: any) => ({ apiKey: c.apiKey, baseUrl: c.baseUrl ?? meta.baseUrl ?? null }));
      }
      // Simple format
      if (meta.apiKey) return [{ apiKey: meta.apiKey, baseUrl: meta.baseUrl ?? null }];
    } catch {}
  }
  if (credential.accessToken) return [{ apiKey: credential.accessToken }];
  return [];
}

function getStoredSiteIds(credential: { metadata?: string | null }): StoredSite[] {
  if (!credential.metadata) return [];
  try {
    const meta = JSON.parse(credential.metadata);
    if (!Array.isArray(meta.siteIds)) return [];
    return meta.siteIds
      .filter((s: any) => typeof s === "object" && s && (s.siteId || s.id || s.meterNumber))
      .map((s: any) => ({
        siteId: String(s.siteId ?? s.id ?? s.meterNumber).trim(),
        name: s.name ?? s.siteName ?? null,
      }));
  } catch {
    return [];
  }
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    const contexts = getContexts(credential);
    const allSites: { siteId: string; siteName: string }[] = [];

    // 1. Try API discovery
    for (const ctx of contexts) {
      try {
        const { sites } = await seListSites(ctx);
        allSites.push(...sites.map((s) => ({ siteId: s.siteId, siteName: s.siteName })));
      } catch (err) {
        console.error(`[SolarEdge adapter] listSites API error:`, err instanceof Error ? err.message : err);
      }
    }

    if (allSites.length > 0) return allSites;

    // 2. Fall back to stored site IDs from metadata
    const stored = getStoredSiteIds(credential);
    if (stored.length > 0) {
      return stored.map((s) => ({
        siteId: s.siteId,
        siteName: s.name ?? `Site ${s.siteId}`,
      }));
    }

    // 3. Neither source produced sites
    throw new Error(
      "SolarEdge site list API returned 0 sites and no site IDs are stored. " +
      "Upload a CSV of site IDs on the Monitoring Dashboard to enable this credential."
    );
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string
  ) {
    const contexts = getContexts(credential);
    if (contexts.length === 0) return siteIds.map((id) => ({ siteId: id, siteName: null, status: "Error" as const, lifetimeKwh: null, errorMessage: "No credentials" }));

    const results = [];
    for (const siteId of siteIds) {
      let found = false;
      for (const ctx of contexts) {
        try {
          const snap = await getSiteProductionSnapshot(ctx, siteId, anchorDate);
          if (snap.status === "Found" || snap.found) {
            results.push({
              siteId,
              siteName: snap.siteName ?? null,
              status: snap.status as "Found" | "Not Found" | "Error",
              lifetimeKwh: snap.lifetimeKwh ?? null,
            });
            found = true;
            break;
          }
        } catch {
          // Try next context
        }
      }
      if (!found) {
        // Fall back to first context for error reporting
        try {
          const snap = await getSiteProductionSnapshot(contexts[0], siteId, anchorDate);
          results.push({
            siteId,
            siteName: snap.siteName ?? null,
            status: snap.status as "Found" | "Not Found" | "Error",
            lifetimeKwh: snap.lifetimeKwh ?? null,
          });
        } catch (err) {
          results.push({ siteId, siteName: null, status: "Error" as const, lifetimeKwh: null, errorMessage: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return results;
  },
};

export default adapter;
