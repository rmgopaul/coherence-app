import {
  getSolarRecDashboardPayload,
  getSolarRecDatasetSyncStates,
  hashSolarRecPayload,
  type SolarRecDatasetSyncStateRecord,
} from "../../db";
import { storageExists, storageGet } from "../../storage";
import { parseChunkPointerPayload } from "../../routers/helpers/scheduleB";
import { mapWithConcurrency } from "../core/concurrency";

// Outer concurrency: number of datasets whose status we verify in
// parallel. Kept modest because each dataset fans out ~N chunks of
// backend work beneath it.
const DATASET_STATUS_CONCURRENCY = 4;

// Inner concurrency: how many chunk-recoverability checks run in
// parallel within a single dataset. Each check is a DB read plus
// (possibly) a storage HEAD; 16 saturates the DB pool's useful
// parallelism without starving other request handlers.
const CHUNK_CHECK_CONCURRENCY = 16;

const DATASET_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

type RemoteDatasetSourceManifestEntry = {
  storageKey: string;
  chunkKeys: string[];
};

export type RawDatasetCloudStatus = {
  datasetKey: string;
  storageUserId: number;
  recoverable: boolean;
  payloadSha256: string | null;
  updatedAt: string | null;
  missingKeys: string[];
};

function buildDatasetDbStorageKey(rawKey: string): string {
  return `dataset:${rawKey}`;
}

function buildDatasetStoragePath(userId: number, rawKey: string): string {
  return `solar-rec-dashboard/${userId}/datasets/${rawKey}.json`;
}

function parseRemoteSourceManifestPayload(
  payload: string
): RemoteDatasetSourceManifestEntry[] | null {
  try {
    const parsed = JSON.parse(payload) as {
      _rawSourcesV1?: unknown;
      version?: unknown;
      sources?: unknown;
    };
    if (parsed._rawSourcesV1 !== true || parsed.version !== 1) return null;
    if (!Array.isArray(parsed.sources)) return null;

    const sources = parsed.sources
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const candidate = entry as {
          storageKey?: unknown;
          chunkKeys?: unknown;
        };
        if (
          typeof candidate.storageKey !== "string" ||
          !DATASET_KEY_PATTERN.test(candidate.storageKey)
        ) {
          return null;
        }
        const chunkKeys = Array.isArray(candidate.chunkKeys)
          ? candidate.chunkKeys.filter(
              (chunkKey): chunkKey is string =>
                typeof chunkKey === "string" &&
                DATASET_KEY_PATTERN.test(chunkKey)
            )
          : [];
        return {
          storageKey: candidate.storageKey,
          chunkKeys,
        };
      })
      .filter(
        (entry): entry is RemoteDatasetSourceManifestEntry => Boolean(entry)
      );

    return sources;
  } catch {
    return null;
  }
}

async function readPayloadFromStoragePath(
  storagePath: string
): Promise<string | null> {
  try {
    const { url } = await storageGet(storagePath);
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function loadDatasetPayload(
  userId: number,
  rawKey: string
): Promise<string | null> {
  const dbPayload = await getSolarRecDashboardPayload(
    userId,
    buildDatasetDbStorageKey(rawKey)
  );
  if (dbPayload !== null) {
    return dbPayload;
  }

  return readPayloadFromStoragePath(buildDatasetStoragePath(userId, rawKey));
}

async function isChildKeyRecoverable(
  userId: number,
  rawKey: string,
  record: SolarRecDatasetSyncStateRecord | undefined
): Promise<boolean> {
  if (record) {
    if ((record.payloadBytes ?? 0) <= 0) return false;
    if (record.dbPersisted) return true;
    if (record.storageSynced) {
      return storageExists(buildDatasetStoragePath(userId, rawKey));
    }
    return false;
  }

  const dbPayload = await getSolarRecDashboardPayload(
    userId,
    buildDatasetDbStorageKey(rawKey)
  );
  if (dbPayload !== null) {
    return dbPayload.length > 0;
  }
  return storageExists(buildDatasetStoragePath(userId, rawKey));
}

function collectReferencedDatasetKeys(payload: string): string[] {
  const chunkKeys = parseChunkPointerPayload(payload);
  if (chunkKeys && chunkKeys.length > 0) {
    return chunkKeys;
  }

  const sourceManifest = parseRemoteSourceManifestPayload(payload);
  if (!sourceManifest || sourceManifest.length === 0) {
    return [];
  }

  const referenced = new Set<string>();
  sourceManifest.forEach((source) => {
    referenced.add(source.storageKey);
    source.chunkKeys.forEach((chunkKey) => referenced.add(chunkKey));
  });
  return Array.from(referenced);
}

export async function getRawDatasetCloudStatuses(
  datasetKeys: string[],
  resolveStorageUserId: (datasetKey: string) => Promise<number>
): Promise<RawDatasetCloudStatus[]> {
  // Fully parallel implementation. The prior version processed
  // datasets sequentially and within each dataset walked every
  // referenced chunk key with sequential awaits. For a user with 14
  // chunked datasets averaging ~150 chunks each, that was roughly
  // 2,000 serialized DB+storage round-trips per call — ~14 seconds
  // wall time in the live log, pinning the badge query and blocking
  // refetchOnWindowFocus.
  //
  // Now: datasets verified in parallel (bounded), and chunk-level
  // recoverability checks within each dataset also run in parallel
  // (bounded). Top-level payload load and sync-state row read are
  // issued as a single Promise.all per dataset.
  return mapWithConcurrency(
    datasetKeys,
    DATASET_STATUS_CONCURRENCY,
    async (datasetKey): Promise<RawDatasetCloudStatus> => {
      const storageUserId = await resolveStorageUserId(datasetKey);
      const topLevelStorageKey = buildDatasetDbStorageKey(datasetKey);

      const [topLevelRecords, topLevelPayload] = await Promise.all([
        getSolarRecDatasetSyncStates(storageUserId, [topLevelStorageKey]),
        loadDatasetPayload(storageUserId, datasetKey),
      ]);
      const topLevelRecord = topLevelRecords[0];

      if (!topLevelPayload) {
        return {
          datasetKey,
          storageUserId,
          recoverable: false,
          payloadSha256:
            topLevelRecord?.payloadSha256 && topLevelRecord.payloadSha256.length > 0
              ? topLevelRecord.payloadSha256
              : null,
          updatedAt: topLevelRecord?.updatedAt?.toISOString() ?? null,
          missingKeys: [datasetKey],
        };
      }

      const referencedKeys = collectReferencedDatasetKeys(topLevelPayload);
      const referencedRecords = referencedKeys.length
        ? await getSolarRecDatasetSyncStates(
            storageUserId,
            referencedKeys.map((rawKey) => buildDatasetDbStorageKey(rawKey))
          )
        : [];
      const referencedRecordMap = new Map(
        referencedRecords.map((record) => [record.storageKey, record])
      );

      const recoverabilityResults = await mapWithConcurrency(
        referencedKeys,
        CHUNK_CHECK_CONCURRENCY,
        async (rawKey) => {
          const recoverable = await isChildKeyRecoverable(
            storageUserId,
            rawKey,
            referencedRecordMap.get(buildDatasetDbStorageKey(rawKey))
          );
          return { rawKey, recoverable };
        }
      );

      const missingKeys = recoverabilityResults
        .filter((result) => !result.recoverable)
        .map((result) => result.rawKey);

      return {
        datasetKey,
        storageUserId,
        recoverable: missingKeys.length === 0,
        payloadSha256:
          topLevelRecord?.payloadSha256 && topLevelRecord.payloadSha256.length > 0
            ? topLevelRecord.payloadSha256
            : hashSolarRecPayload(topLevelPayload),
        updatedAt: topLevelRecord?.updatedAt?.toISOString() ?? null,
        missingKeys,
      };
    }
  );
}
