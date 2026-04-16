/**
 * Field-by-field parity diff between a client-computed SystemRecord[]
 * and a server-computed one (received over tRPC, so dates are ISO
 * strings rather than Date objects).
 *
 * Used by the parity report UI to verify the server-side compute
 * matches the client-side compute before we retire IndexedDB.
 */

import type { SystemRecord } from "../state/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FieldMismatch = {
  systemKey: string;
  field: keyof SystemRecord;
  clientValue: string;
  serverValue: string;
};

export type ParityReport = {
  clientSystemCount: number;
  serverSystemCount: number;
  systemsOnlyOnClient: string[];
  systemsOnlyOnServer: string[];
  systemsWithMismatches: number;
  totalFieldMismatches: number;
  mismatchesByField: Record<string, number>;
  firstMismatches: FieldMismatch[];
};

type UnknownSystem = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------

const EPSILON = 1e-6;

/**
 * Convert any value to a stable comparable form:
 *  - Date -> ISO string
 *  - Date-looking ISO string -> same ISO string
 *  - null / undefined -> null
 *  - number -> number (compared with epsilon tolerance elsewhere)
 *  - everything else -> string
 */
function normalize(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") return value;
  return String(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  if (typeof na === "number" && typeof nb === "number") {
    return Math.abs(na - nb) <= EPSILON;
  }
  return na === nb;
}

function displayValue(value: unknown): string {
  const n = normalize(value);
  if (n === null) return "null";
  return String(n);
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

const TRACKED_FIELDS: readonly (keyof SystemRecord)[] = [
  "key",
  "systemId",
  "stateApplicationRefId",
  "trackingSystemRefId",
  "systemName",
  "installedKwAc",
  "installedKwDc",
  "sizeBucket",
  "recPrice",
  "totalContractAmount",
  "contractedRecs",
  "deliveredRecs",
  "contractedValue",
  "deliveredValue",
  "valueGap",
  "latestReportingDate",
  "latestReportingKwh",
  "isReporting",
  "isTerminated",
  "isTransferred",
  "ownershipStatus",
  "hasChangedOwnership",
  "changeOwnershipStatus",
  "contractStatusText",
  "contractType",
  "zillowStatus",
  "zillowSoldDate",
  "contractedDate",
  "monitoringType",
  "monitoringPlatform",
  "installerName",
  "part2VerificationDate",
];

const MAX_FIRST_MISMATCHES = 50;

export function diffSystems(
  clientSystems: SystemRecord[],
  serverSystems: unknown[]
): ParityReport {
  const clientByKey = new Map<string, SystemRecord>();
  for (const sys of clientSystems) clientByKey.set(sys.key, sys);

  const serverByKey = new Map<string, UnknownSystem>();
  for (const sys of serverSystems) {
    if (sys && typeof sys === "object" && "key" in sys) {
      serverByKey.set(String((sys as UnknownSystem).key), sys as UnknownSystem);
    }
  }

  const systemsOnlyOnClient: string[] = [];
  const systemsOnlyOnServer: string[] = [];
  clientByKey.forEach((_, key) => {
    if (!serverByKey.has(key)) systemsOnlyOnClient.push(key);
  });
  serverByKey.forEach((_, key) => {
    if (!clientByKey.has(key)) systemsOnlyOnServer.push(key);
  });

  const mismatchesByField: Record<string, number> = {};
  const firstMismatches: FieldMismatch[] = [];
  let totalFieldMismatches = 0;
  const systemsWithMismatchSet = new Set<string>();

  const clientEntries = Array.from(clientByKey.entries());
  for (const [key, clientSys] of clientEntries) {
    const serverSys = serverByKey.get(key);
    if (!serverSys) continue;

    for (const field of TRACKED_FIELDS) {
      const cv = clientSys[field];
      const sv = serverSys[field];
      if (!valuesEqual(cv, sv)) {
        totalFieldMismatches += 1;
        mismatchesByField[field] = (mismatchesByField[field] ?? 0) + 1;
        systemsWithMismatchSet.add(key);
        if (firstMismatches.length < MAX_FIRST_MISMATCHES) {
          firstMismatches.push({
            systemKey: key,
            field,
            clientValue: displayValue(cv),
            serverValue: displayValue(sv),
          });
        }
      }
    }
  }

  return {
    clientSystemCount: clientSystems.length,
    serverSystemCount: serverSystems.length,
    systemsOnlyOnClient,
    systemsOnlyOnServer,
    systemsWithMismatches: systemsWithMismatchSet.size,
    totalFieldMismatches,
    mismatchesByField,
    firstMismatches,
  };
}
