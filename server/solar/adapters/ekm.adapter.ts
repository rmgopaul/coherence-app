import {
  getMeterProductionSnapshot,
  type EkmApiContext,
} from "../../services/solar/ekm";

type StoredSite = { meterNumber: string; name?: string | null };

function getContext(credential: { accessToken?: string | null; metadata?: string | null }): { ctx: EkmApiContext; siteIds: StoredSite[] } | null {
  if (credential.metadata) {
    try {
      const meta = JSON.parse(credential.metadata);
      const apiKey = meta.apiKey ?? credential.accessToken;
      if (!apiKey) return null;
      const ctx: EkmApiContext = {
        apiKey,
        baseUrl: meta.baseUrl ?? null,
      };
      // EKM has no list-meters API — site IDs are stored in metadata.siteIds
      type EkmRawSite = {
        meterNumber?: string | number;
        siteId?: string | number;
        id?: string | number;
        name?: string | null;
        siteName?: string | null;
      };
      const siteIds: StoredSite[] = Array.isArray(meta.siteIds)
        ? meta.siteIds
            .filter((s: unknown): s is EkmRawSite =>
              typeof s === "object" && s !== null && (
                (s as EkmRawSite).meterNumber !== undefined ||
                (s as EkmRawSite).siteId !== undefined ||
                (s as EkmRawSite).id !== undefined
              )
            )
            .map((s: EkmRawSite) => ({
              meterNumber: String(s.meterNumber ?? s.siteId ?? s.id).trim(),
              name: s.name ?? s.siteName ?? null,
            }))
        : [];
      return { ctx, siteIds };
    } catch {}
  }
  if (credential.accessToken) {
    return { ctx: { apiKey: credential.accessToken }, siteIds: [] };
  }
  return null;
}

const adapter = {
  async listSites(credential: { accessToken?: string | null; metadata?: string | null }) {
    const parsed = getContext(credential);
    if (!parsed) throw new Error("EKM requires an apiKey in metadata.");
    if (parsed.siteIds.length === 0) {
      throw new Error(
        'EKM has no site discovery API. Add meter numbers to this credential\'s metadata under "siteIds": [{"meterNumber": "300001234", "name": "Site A"}]'
      );
    }
    return parsed.siteIds.map((s) => ({
      siteId: s.meterNumber,
      siteName: s.name ?? `EKM Meter ${s.meterNumber}`,
    }));
  },

  async getSnapshots(
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string,
  ) {
    const parsed = getContext(credential);
    if (!parsed) return siteIds.map((id) => ({ siteId: id, siteName: null, status: "Error" as const, lifetimeKwh: null, errorMessage: "No credentials" }));
    const results = [];
    for (const meterNumber of siteIds) {
      try {
        const snap = await getMeterProductionSnapshot(parsed.ctx, meterNumber, anchorDate);
        results.push({
          siteId: meterNumber,
          siteName: snap.name ?? null,
          status: snap.status as "Found" | "Not Found" | "Error",
          lifetimeKwh: snap.lifetimeKwh ?? null,
        });
      } catch (err) {
        results.push({
          siteId: meterNumber,
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
