/**
 * SolarEdge monitoring adapter.
 *
 * Site discovery priority:
 *   1. Stored site IDs in metadata.siteIds (from CSV upload) — instant, no API call
 *   2. SolarEdge /sites/list API discovery — only attempted when no stored sites exist
 *
 * When the user has uploaded a CSV, the stored list is authoritative.
 * This avoids a 60+ second timeout on a known-failing API key.
 */
import {
  listSites as seListSites,
  getSiteProductionSnapshot,
  type SolarEdgeApiContext,
} from "../../services/solar/solarEdge";

type StoredSite = { siteId: string; name?: string | null };

type SolarEdgeConnection = {
  apiKey?: string;
  baseUrl?: string | null;
};

type SolarEdgeStoredSite = {
  siteId?: string | number;
  id?: string | number;
  meterNumber?: string | number;
  name?: string | null;
  siteName?: string | null;
};

function getContexts(credential: { accessToken?: string | null; metadata?: string | null }): SolarEdgeApiContext[] {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      if (meta.connections && Array.isArray(meta.connections)) {
        return meta.connections
          .filter((c: SolarEdgeConnection) => c.apiKey)
          .map((c: SolarEdgeConnection) => ({ apiKey: c.apiKey as string, baseUrl: c.baseUrl ?? meta.baseUrl ?? null }));
      }
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
      .filter((s: SolarEdgeStoredSite | unknown): s is SolarEdgeStoredSite =>
        typeof s === "object" && s !== null && (
          (s as SolarEdgeStoredSite).siteId !== undefined ||
          (s as SolarEdgeStoredSite).id !== undefined ||
          (s as SolarEdgeStoredSite).meterNumber !== undefined
        )
      )
      .map((s: SolarEdgeStoredSite) => ({
        siteId: String(s.siteId ?? s.id ?? s.meterNumber).trim(),
        name: s.name ?? s.siteName ?? null,
      }));
  } catch {
    return [];
  }
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    // 1. Stored site IDs take priority — instant, no API call
    const stored = getStoredSiteIds(credential);
    if (stored.length > 0) {
      return stored.map((s) => ({
        siteId: s.siteId,
        siteName: s.name ?? `Site ${s.siteId}`,
      }));
    }

    // 2. No stored sites — try API discovery
    const contexts = getContexts(credential);
    const allSites: { siteId: string; siteName: string }[] = [];
    for (const ctx of contexts) {
      try {
        const { sites } = await seListSites(ctx);
        allSites.push(...sites.map((s) => ({ siteId: s.siteId, siteName: s.siteName })));
      } catch (err) {
        console.error(`[SolarEdge adapter] listSites API error:`, err instanceof Error ? err.message : err);
      }
    }
    if (allSites.length > 0) return allSites;

    // 3. Neither source produced sites
    throw new Error(
      "SolarEdge: no stored site IDs and the /sites/list API returned 0 sites. " +
      "Upload a CSV of site IDs on the Monitoring Dashboard."
    );
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string
  ) {
    const contexts = getContexts(credential);
    if (contexts.length === 0) {
      return siteIds.map((id) => ({
        siteId: id,
        siteName: null,
        status: "Error" as const,
        lifetimeKwh: null,
        errorMessage: "No SolarEdge API credentials configured.",
      }));
    }

    const results = [];
    for (const siteId of siteIds) {
      let found = false;
      for (const ctx of contexts) {
        try {
          const snap = await getSiteProductionSnapshot(ctx, siteId, anchorDate);
          if (snap.status === "Found" || snap.found) {
            results.push({
              siteId,
              siteName: snap.name ?? null,
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
        try {
          const snap = await getSiteProductionSnapshot(contexts[0], siteId, anchorDate);
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
    }
    return results;
  },
};

export default adapter;
