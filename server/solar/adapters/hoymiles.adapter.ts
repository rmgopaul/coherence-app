import { createHash } from "crypto";

import {
  getStationProductionSnapshot,
  listStations,
} from "../../services/solar/hoymiles";
import {
  extractHoymilesCredentialProfiles,
  type HoymilesCredentialProfile,
  type HoymilesCredentialSource,
} from "../../services/solar/hoymilesCredentials";
import { mapWithConcurrency } from "../../services/core/concurrency";

type HoymilesCredential = HoymilesCredentialSource & {
  accessToken?: string | null;
  metadata?: string | null;
};

type HoymilesSite = {
  siteId: string;
  siteName: string;
};

type HoymilesSnapshotResult = {
  siteId: string;
  siteName: string | null;
  status: "Found" | "Not Found" | "Error";
  lifetimeKwh: number | null;
  errorMessage?: string;
};

type StationDirectoryEntry = HoymilesSite & {
  profile: HoymilesCredentialProfile;
};

type StationDirectory = {
  sites: HoymilesSite[];
  byId: Map<string, StationDirectoryEntry>;
  errors: string[];
};

const DIRECTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const directoryCache = new Map<
  string,
  { createdAt: number; promise: Promise<StationDirectory> }
>();

function normalizeSiteKey(siteId: string): string {
  return siteId.trim().toLowerCase();
}

function profileCacheKey(profile: HoymilesCredentialProfile): string {
  return [
    profile.id,
    profile.credentialId ?? "",
    profile.sourceConnectionId ?? "",
    profile.username,
    createHash("sha256").update(profile.password).digest("hex").slice(0, 16),
    profile.baseUrl ?? "",
  ].join("::");
}

function directoryCacheKey(profiles: HoymilesCredentialProfile[]): string {
  return profiles.map(profileCacheKey).sort().join("||");
}

function getProfiles(
  credential: HoymilesCredential
): HoymilesCredentialProfile[] {
  return extractHoymilesCredentialProfiles(credential);
}

async function loadStationDirectory(
  profiles: HoymilesCredentialProfile[]
): Promise<StationDirectory> {
  const cacheKey = directoryCacheKey(profiles);
  const now = Date.now();
  const cached = directoryCache.get(cacheKey);
  if (cached && now - cached.createdAt <= DIRECTORY_CACHE_TTL_MS) {
    return cached.promise;
  }

  const promise = mapWithConcurrency(profiles, 3, async profile => {
    try {
      const result = await listStations(profile.context);
      return {
        profile,
        stations: result.stations,
        error: null as string | null,
      };
    } catch (error) {
      return {
        profile,
        stations: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })
    .then(results => {
      const byId = new Map<string, StationDirectoryEntry>();
      const sites: HoymilesSite[] = [];
      const errors = results
        .filter(result => result.error)
        .map(result => `${result.profile.name}: ${result.error}`);

      for (const result of results) {
        for (const station of result.stations) {
          const key = normalizeSiteKey(station.stationId);
          if (!key || byId.has(key)) continue;
          const site = {
            siteId: station.stationId,
            siteName: station.name,
            profile: result.profile,
          };
          byId.set(key, site);
          sites.push({ siteId: site.siteId, siteName: site.siteName });
        }
      }

      if (sites.length === 0 && errors.length > 0) {
        throw new Error(
          `Hoymiles station discovery failed: ${errors.join(" | ")}`
        );
      }

      return { sites, byId, errors };
    })
    .catch(error => {
      directoryCache.delete(cacheKey);
      throw error;
    });

  directoryCache.set(cacheKey, { createdAt: now, promise });
  return promise;
}

function noCredentialRows(siteIds: string[]): HoymilesSnapshotResult[] {
  return siteIds.map(siteId => ({
    siteId,
    siteName: null,
    status: "Error" as const,
    lifetimeKwh: null,
    errorMessage: "Hoymiles requires username and password in metadata.",
  }));
}

const adapter = {
  supportsBulkSnapshots: true,
  snapshotTimeoutMs: 5 * 60 * 1000,

  async listSites(credential: HoymilesCredential) {
    const profiles = getProfiles(credential);
    if (profiles.length === 0) {
      throw new Error("Hoymiles requires username and password in metadata.");
    }
    const directory = await loadStationDirectory(profiles);
    return directory.sites;
  },

  async getSnapshots(
    credential: HoymilesCredential,
    siteIds: string[],
    anchorDate: string
  ): Promise<HoymilesSnapshotResult[]> {
    const profiles = getProfiles(credential);
    if (profiles.length === 0) return noCredentialRows(siteIds);

    let directory: StationDirectory;
    try {
      directory = await loadStationDirectory(profiles);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return siteIds.map(siteId => ({
        siteId,
        siteName: null,
        status: "Error" as const,
        lifetimeKwh: null,
        errorMessage: message,
      }));
    }

    return mapWithConcurrency(siteIds, 4, async siteId => {
      const directoryEntry = directory.byId.get(normalizeSiteKey(siteId));
      const profile =
        directoryEntry?.profile ?? (profiles.length === 1 ? profiles[0] : null);

      if (!profile) {
        return {
          siteId,
          siteName: directoryEntry?.siteName ?? null,
          status: "Not Found" as const,
          lifetimeKwh: null,
          errorMessage:
            directory.errors.length > 0
              ? `Hoymiles profile discovery was partial; no profile matched site "${siteId}". ${directory.errors.join(" | ")}`
              : `No Hoymiles profile matched site "${siteId}".`,
        };
      }

      try {
        const snap = await getStationProductionSnapshot(
          profile.context,
          siteId,
          anchorDate,
          directoryEntry?.siteName
        );
        return {
          siteId,
          siteName: snap.name ?? directoryEntry?.siteName ?? null,
          status: snap.status,
          lifetimeKwh: snap.lifetimeKwh ?? null,
          errorMessage: snap.error ?? undefined,
        };
      } catch (error) {
        return {
          siteId,
          siteName: directoryEntry?.siteName ?? null,
          status: "Error" as const,
          lifetimeKwh: null,
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
    });
  },
};

export default adapter;
