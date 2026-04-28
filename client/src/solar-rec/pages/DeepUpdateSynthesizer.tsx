import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
// Task 5.5 (2026-04-26): solarRecDashboard.* moved to the standalone
// Solar REC router. Aliased import keeps the call sites unchanged.
import { solarRecTrpc as trpc } from "@/solar-rec/solarRecTrpc";
import {
  type DeepUpdateReportData,
  type DeepUpdateReportKey,
  parseDeepUpdateReportFile,
  synthesizeDeepUpdate,
  type DeepUpdateSynthesisResult,
} from "@/lib/deepUpdateSynth";
import { toErrorMessage, formatPercent } from "@/lib/helpers";
import { ArrowLeft, Database, Download, Loader2, Upload, AlertCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { useLocation } from "wouter";

const DEEP_UPDATE_DB_NAME = "deepUpdateSynthDb";
const DEEP_UPDATE_DB_VERSION = 1;
const DEEP_UPDATE_STORE = "reports";
const DEEP_UPDATE_RECORD_KEY = "activeReports";
const DEEP_UPDATE_REMOTE_MANIFEST_KEY = "deep_update_manifest_v1";
const DEEP_UPDATE_REMOTE_CHUNK_CHAR_LIMIT = 500_000;
const DEEP_UPDATE_PREVIEW_PAGE_SIZE = 50;
const DEEP_UPDATE_OUTPUT_PAGE_SIZE = 25;
const DEEP_UPDATE_REMOTE_REPORT_WARN_CHARS = 8_000_000;

type DeepUpdateRemoteReportPayload = {
  fileName: string;
  sheetName: string;
  headers: string[];
  rows: Array<Record<string, unknown>>;
  uploadedAt?: number;
};

// Per-report cloud sync state. Only populated for reports that have
// been touched in this browser session — leaves untouched reports'
// status undefined so the UI can hide the badge entirely. The chunked
// writer flow drives every transition: handleUpload / clearUpload set
// "pending"; the cloud-sync useEffect promotes to "syncing" with chunk
// progress, then "synced" or "failed".
type CloudSyncStatus =
  | { state: "pending" }
  | { state: "syncing"; chunksDone: number; chunksTotal: number }
  | { state: "synced"; syncedAt: number }
  | { state: "failed"; message: string };

function isDeepUpdateReportKey(value: string): value is DeepUpdateReportKey {
  return [
    "portal",
    "abpReport",
    "sd",
    "iccReport1",
    "iccReport2",
    "iccReport3",
    "portalPayments",
  ].includes(value);
}

function normalizeDeepUpdateReport(
  key: DeepUpdateReportKey,
  value:
    | {
        fileName?: unknown;
        sheetName?: unknown;
        headers?: unknown;
        rows?: unknown;
        uploadedAt?: unknown;
      }
    | null
    | undefined
): DeepUpdateReportData | null {
  if (!value || !Array.isArray(value.headers) || !Array.isArray(value.rows)) return null;
  const rows = value.rows as Array<Record<string, unknown>>;
  return {
    key,
    fileName: typeof value.fileName === "string" ? value.fileName : `${key}.csv`,
    sheetName: typeof value.sheetName === "string" ? value.sheetName : "",
    headers: value.headers.map((header) => String(header)),
    rows: rows.map((row) => {
      const normalized: Record<string, string> = {};
      if (row && typeof row === "object") {
        Object.entries(row as Record<string, unknown>).forEach(([header, cell]) => {
          normalized[header] = cell === null || cell === undefined ? "" : String(cell);
        });
      }
      return normalized;
    }),
    // Pre-timestamp uploads (legacy IDB / cloud rows written before
    // this field existed) get 0 so any fresh upload wins on merge.
    uploadedAt: typeof value.uploadedAt === "number" && Number.isFinite(value.uploadedAt) ? value.uploadedAt : 0,
  };
}

function reportStorageKey(key: DeepUpdateReportKey): string {
  return `deep_update_report_${key}`;
}

function splitTextIntoChunks(value: string, chunkSize: number): string[] {
  if (value.length <= chunkSize) return [value];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks;
}

function buildRemoteChunkKey(reportKey: DeepUpdateReportKey, chunkIndex: number): string {
  return `du_${reportKey}_chunk_${String(chunkIndex).padStart(4, "0")}`;
}

function buildChunkPointerPayload(chunkKeys: string[]): string {
  return JSON.stringify({
    _chunkedDeepUpdateReport: true,
    chunkKeys,
  });
}

function parseChunkPointerPayload(payload: string): string[] | null {
  try {
    const parsed = JSON.parse(payload) as { _chunkedDeepUpdateReport?: unknown; chunkKeys?: unknown };
    if (parsed._chunkedDeepUpdateReport !== true) return null;
    if (!Array.isArray(parsed.chunkKeys) || parsed.chunkKeys.length === 0) return null;
    const chunkKeyPattern = /^[a-zA-Z0-9_-]{1,64}$/;
    const chunkKeys = parsed.chunkKeys.filter(
      (key): key is string => typeof key === "string" && chunkKeyPattern.test(key)
    );
    return chunkKeys.length === parsed.chunkKeys.length ? chunkKeys : null;
  } catch {
    return null;
  }
}

function buildManifestPayload(keys: DeepUpdateReportKey[]): string {
  return JSON.stringify({
    keys,
    updatedAt: new Date().toISOString(),
  });
}

function parseManifestPayload(payload: string): DeepUpdateReportKey[] {
  try {
    const parsed = JSON.parse(payload) as { keys?: unknown };
    if (!Array.isArray(parsed.keys)) return [];
    return parsed.keys.filter((key): key is DeepUpdateReportKey => typeof key === "string" && isDeepUpdateReportKey(key));
  } catch {
    return [];
  }
}

function serializeReportForRemote(report: DeepUpdateReportData): string {
  const payload: DeepUpdateRemoteReportPayload = {
    fileName: report.fileName,
    sheetName: report.sheetName,
    headers: report.headers,
    rows: report.rows,
    uploadedAt: report.uploadedAt,
  };
  return JSON.stringify(payload);
}

function deserializeReportFromRemote(payload: string, key: DeepUpdateReportKey): DeepUpdateReportData | null {
  try {
    const parsed = JSON.parse(payload) as DeepUpdateRemoteReportPayload;
    return normalizeDeepUpdateReport(key, parsed);
  } catch {
    return null;
  }
}

function buildReportsSignature(reports: Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>>): string {
  return REPORTS.map((report) => {
    const reportData = reports[report.key];
    if (!reportData) return `${report.key}:none`;
    return `${report.key}:${reportData.fileName}|${reportData.sheetName}|${reportData.headers.length}|${reportData.rows.length}`;
  }).join("||");
}

async function openDeepUpdateDatabase(): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available."));
      return;
    }

    const request = window.indexedDB.open(DEEP_UPDATE_DB_NAME, DEEP_UPDATE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEEP_UPDATE_STORE)) {
        db.createObjectStore(DEEP_UPDATE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open storage."));
  });
}

async function loadDeepUpdateReportsFromStorage(): Promise<Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>>> {
  if (typeof window === "undefined" || !("indexedDB" in window)) return {};

  try {
    const db = await openDeepUpdateDatabase();
    const payload = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(DEEP_UPDATE_STORE, "readonly");
      const store = tx.objectStore(DEEP_UPDATE_STORE);
      const request = store.get(DEEP_UPDATE_RECORD_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Failed to read stored reports."));
      tx.oncomplete = () => db.close();
      tx.onabort = () => db.close();
      tx.onerror = () => db.close();
    });

    if (!payload || typeof payload !== "object") return {};
    const raw = payload as Record<string, DeepUpdateReportData>;
    const restored: Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>> = {};

    Object.entries(raw).forEach(([key, value]) => {
      if (!isDeepUpdateReportKey(key)) return;
      const normalized = normalizeDeepUpdateReport(key, value);
      if (!normalized) return;
      restored[key] = normalized;
    });

    return restored;
  } catch {
    return {};
  }
}

async function saveDeepUpdateReportsToStorage(
  reports: Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>>
): Promise<void> {
  if (typeof window === "undefined" || !("indexedDB" in window)) return;

  const db = await openDeepUpdateDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DEEP_UPDATE_STORE, "readwrite");
    const store = tx.objectStore(DEEP_UPDATE_STORE);
    const request = store.put(reports, DEEP_UPDATE_RECORD_KEY);
    request.onerror = () => reject(request.error ?? new Error("Failed to save reports."));
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("Failed to save reports."));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Failed to save reports."));
    };
  });
}

const REPORTS: Array<{ key: DeepUpdateReportKey; label: string; required: boolean; description: string }> = [
  {
    key: "portal",
    label: "Portal",
    required: true,
    description: "Main portal export containing system_id, internal_status, sd_status, and contract_status.",
  },
  {
    key: "abpReport",
    label: "ABP Report",
    required: true,
    description: "ABP export containing Part_1/Part_2 statuses, batch, trade date, and contract IDs.",
  },
  {
    key: "iccReport1",
    label: "ICC Report 1",
    required: false,
    description: "Uploadable for completeness. Current synthesis logic does not require it yet.",
  },
  {
    key: "iccReport2",
    label: "ICC Report 2",
    required: true,
    description: "Used for REC price fallback, contract value fallback, and scheduled energization date.",
  },
  {
    key: "iccReport3",
    label: "ICC Report 3",
    required: true,
    description: "Primary source for REC price and total REC delivery contract value.",
  },
  {
    key: "portalPayments",
    label: "Portal Payments (Optional)",
    required: false,
    description: "Recommended if you want payment-based steps (Step 4.2 / 4.3) resolved.",
  },
];
const ACTIVE_REPORT_KEY_SET = new Set<DeepUpdateReportKey>(REPORTS.map((report) => report.key));

function filterReportsToActive(
  reports: Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>>
): Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>> {
  const filtered: Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>> = {};
  REPORTS.forEach((report) => {
    const value = reports[report.key];
    if (value) filtered[report.key] = value;
  });
  return filtered;
}

function triggerCsvDownload(fileName: string, csvText: string): void {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function DeepUpdateSynthesizer() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();

  const [reports, setReports] = useState<Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>>>({});
  const [uploadErrors, setUploadErrors] = useState<Partial<Record<DeepUpdateReportKey, string>>>({});
  const [activeUpload, setActiveUpload] = useState<DeepUpdateReportKey | null>(null);
  const [result, setResult] = useState<DeepUpdateSynthesisResult | null>(null);
  const [synthError, setSynthError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [lastSuccessfulSynthesisAt, setLastSuccessfulSynthesisAt] = useState<Date | null>(null);
  const [statusPreviewPage, setStatusPreviewPage] = useState(1);
  const [deepUpdatePreviewPage, setDeepUpdatePreviewPage] = useState(1);
  const [reportsHydrated, setReportsHydrated] = useState(false);
  const [remoteHydrated, setRemoteHydrated] = useState(false);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const [cloudSyncStatuses, setCloudSyncStatuses] = useState<
    Partial<Record<DeepUpdateReportKey, CloudSyncStatus>>
  >({});
  // Save synthesis run state — distinct from the per-report
  // upload sync. Lets the user persist the synthesized result
  // (not just the inputs) under a dedicated `deepUpdateSynthesisRuns_<id>`
  // storage key so a teammate can reload it later.
  const [isSavingSynthesis, setIsSavingSynthesis] = useState(false);
  const [synthesisDbError, setSynthesisDbError] = useState<string | null>(null);
  const getRemoteDataset = trpc.solarRecDashboard.getDataset.useMutation();
  const saveRemoteDataset = trpc.solarRecDashboard.saveDataset.useMutation();
  const getRemoteDatasetRef = useRef(getRemoteDataset);
  getRemoteDatasetRef.current = getRemoteDataset;
  const saveRemoteDatasetRef = useRef(saveRemoteDataset);
  saveRemoteDatasetRef.current = saveRemoteDataset;
  const remoteReportSignaturesRef = useRef<Partial<Record<DeepUpdateReportKey, string>>>({});
  const reportsRef = useRef(reports);
  reportsRef.current = reports;
  const reportsHydratedRef = useRef(reportsHydrated);
  reportsHydratedRef.current = reportsHydrated;
  const localReportsSignatureRef = useRef("");
  const remoteReportsAggregateSignatureRef = useRef("");

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const storedReports = filterReportsToActive(await loadDeepUpdateReportsFromStorage());
      if (cancelled) return;
      if (Object.keys(storedReports).length > 0) {
        setReports(storedReports);
        localReportsSignatureRef.current = buildReportsSignature(storedReports);
      }
      setReportsHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!reportsHydrated) return;
    const nextSignature = buildReportsSignature(reports);
    if (localReportsSignatureRef.current === nextSignature) return;
    const timeout = window.setTimeout(() => {
      void saveDeepUpdateReportsToStorage(reports).catch(() => {
        setStorageNotice(
          "Browser storage is full for this device. Keeping uploads in cloud sync; local browser persistence is limited."
        );
      });
      localReportsSignatureRef.current = nextSignature;
    }, 800);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [reports, reportsHydrated]);

  useEffect(() => {
    if (authLoading || !user || !reportsHydrated) return;

    let cancelled = false;
    void (async () => {
      try {
        const manifestResponse = await getRemoteDatasetRef.current.mutateAsync({ key: DEEP_UPDATE_REMOTE_MANIFEST_KEY });
        const reportKeys = manifestResponse?.payload ? parseManifestPayload(manifestResponse.payload) : [];
        const loaded: Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>> = {};
        const signatures: Partial<Record<DeepUpdateReportKey, string>> = {};

        for (const key of reportKeys) {
          if (cancelled) break;
          if (!ACTIVE_REPORT_KEY_SET.has(key)) continue;
          const storageKey = reportStorageKey(key);
          const response = await getRemoteDatasetRef.current.mutateAsync({ key: storageKey });
          if (!response?.payload) continue;

          let reportPayload = response.payload;
          const chunkKeys = parseChunkPointerPayload(response.payload);
          if (chunkKeys) {
            const chunkPayloads = await Promise.all(
              chunkKeys.map((chunkKey) =>
                getRemoteDatasetRef.current
                  .mutateAsync({ key: chunkKey })
                  .then((chunkResponse) => chunkResponse?.payload ?? null)
                  .catch(() => null)
              )
            );
            if (chunkPayloads.some((chunkPayload) => chunkPayload === null)) continue;
            reportPayload = chunkPayloads.join("");
          }

          const report = deserializeReportFromRemote(reportPayload, key);
          if (!report) continue;
          loaded[key] = report;
          signatures[key] = `${report.fileName}|${report.sheetName}|${report.rows.length}|${report.headers.length}`;
        }

        if (cancelled) return;
        if (Object.keys(loaded).length > 0) {
          setReports((current) => {
            if (Object.keys(current).length === 0) return loaded;
            const merged = { ...current };
            for (const [key, value] of Object.entries(loaded)) {
              if (!value) continue;
              const reportKey = key as DeepUpdateReportKey;
              const existing = merged[reportKey];
              // Prefer whichever upload was parsed more recently. The
              // old logic kept whatever was in IndexedDB and ignored
              // cloud entirely if a key was already loaded — which
              // silently kept stale browser-cached uploads alive even
              // when a teammate (or the same user, on a different
              // device) had pushed a newer file to cloud sync. Legacy
              // entries with no timestamp default to 0, so any
              // timestamped upload wins.
              if (!existing || value.uploadedAt > existing.uploadedAt) {
                merged[reportKey] = value;
              }
            }
            return filterReportsToActive(merged);
          });
        }
        remoteReportSignaturesRef.current = signatures;
        remoteReportsAggregateSignatureRef.current = buildReportsSignature(loaded);
        setStorageNotice(null);
      } catch {
        if (!cancelled) {
          setStorageNotice("Could not load Deep Update uploads from cloud storage.");
        }
      } finally {
        if (!cancelled) setRemoteHydrated(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, reportsHydrated, user]);

  useEffect(() => {
    if (authLoading || !user || !reportsHydrated || !remoteHydrated) return;
    const nextAggregateSignature = buildReportsSignature(reports);
    if (nextAggregateSignature === remoteReportsAggregateSignatureRef.current) return;

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        if (nextAggregateSignature === remoteReportsAggregateSignatureRef.current) return;
        const nextSignatures: Partial<Record<DeepUpdateReportKey, string>> = {};
        let warnedLargePayload = false;

        // Wraps saveDataset.mutateAsync so a server-returned partial-
        // success (storage write OK, DB write failed) throws like a
        // network error would. Without this, `success: false` resolves
        // the promise and the existing failed/synced state machine
        // never sees the DB-side failure — which was the
        // LOCAL-ONLY-NEVER-PERSISTS bug that surfaced as a green
        // "synced" badge on data that wasn't actually recoverable.
        // Compatible with both the legacy server contract (always
        // `success: true`) and the post-PR2 contract (`success:
        // persistedToDatabase`); the dbError check is the load-bearing
        // bit either way.
        const checkMutate = async (args: { key: string; payload: string }) => {
          const res = await saveRemoteDatasetRef.current.mutateAsync(args);
          if (res && res.success === false && res.dbError) {
            throw new Error(`DB persistence failed: ${res.dbError}`);
          }
          return res;
        };

        try {
          for (const report of REPORTS) {
            if (cancelled) return;
            const key = report.key;
            const reportData = reports[key];
            const storageKey = reportStorageKey(key);

            if (!reportData) {
              if (!remoteReportSignaturesRef.current[key]) continue;
              setCloudSyncStatuses((previous) => ({
                ...previous,
                [key]: { state: "syncing", chunksDone: 0, chunksTotal: 1 },
              }));
              try {
                await checkMutate({ key: storageKey, payload: "" });
                delete remoteReportSignaturesRef.current[key];
                setCloudSyncStatuses((previous) => ({
                  ...previous,
                  [key]: { state: "synced", syncedAt: Date.now() },
                }));
              } catch (chunkError) {
                setCloudSyncStatuses((previous) => ({
                  ...previous,
                  [key]: { state: "failed", message: toErrorMessage(chunkError) },
                }));
                throw chunkError;
              }
              continue;
            }

            const signature = `${reportData.fileName}|${reportData.sheetName}|${reportData.rows.length}|${reportData.headers.length}`;
            nextSignatures[key] = signature;
            if (remoteReportSignaturesRef.current[key] === signature) {
              // Already in cloud — surface as synced so the user can see
              // every loaded report has a status, not just the ones they
              // just touched.
              setCloudSyncStatuses((previous) =>
                previous[key] ? previous : { ...previous, [key]: { state: "synced", syncedAt: Date.now() } }
              );
              continue;
            }

            const payload = serializeReportForRemote(reportData);
            if (payload.length > DEEP_UPDATE_REMOTE_REPORT_WARN_CHARS && !warnedLargePayload) {
              warnedLargePayload = true;
              setStorageNotice(
                "Large Deep Update uploads detected. Cloud sync will continue in chunks and may take longer than usual."
              );
            }
            const chunks = splitTextIntoChunks(payload, DEEP_UPDATE_REMOTE_CHUNK_CHAR_LIMIT);

            // Total writes the user will see progress for: chunks +
            // 1 pointer write when multi-chunk; single-chunk uploads
            // are a single write.
            const totalWrites = chunks.length === 1 ? 1 : chunks.length + 1;
            setCloudSyncStatuses((previous) => ({
              ...previous,
              [key]: { state: "syncing", chunksDone: 0, chunksTotal: totalWrites },
            }));

            try {
              if (chunks.length === 1) {
                await checkMutate({ key: storageKey, payload });
                setCloudSyncStatuses((previous) => ({
                  ...previous,
                  [key]: { state: "syncing", chunksDone: 1, chunksTotal: 1 },
                }));
              } else {
                const chunkKeys = chunks.map((_, index) => buildRemoteChunkKey(key, index));
                for (let index = 0; index < chunks.length; index += 1) {
                  await checkMutate({ key: chunkKeys[index], payload: chunks[index] });
                  const done = index + 1;
                  setCloudSyncStatuses((previous) => ({
                    ...previous,
                    [key]: { state: "syncing", chunksDone: done, chunksTotal: totalWrites },
                  }));
                }
                await checkMutate({
                  key: storageKey,
                  payload: buildChunkPointerPayload(chunkKeys),
                });
                setCloudSyncStatuses((previous) => ({
                  ...previous,
                  [key]: { state: "syncing", chunksDone: totalWrites, chunksTotal: totalWrites },
                }));
              }
              remoteReportSignaturesRef.current[key] = signature;
              setCloudSyncStatuses((previous) => ({
                ...previous,
                [key]: { state: "synced", syncedAt: Date.now() },
              }));
            } catch (chunkError) {
              setCloudSyncStatuses((previous) => ({
                ...previous,
                [key]: { state: "failed", message: toErrorMessage(chunkError) },
              }));
              throw chunkError;
            }
          }

          const activeKeys = REPORTS.map((report) => report.key).filter((key) => Boolean(reports[key]));
          await checkMutate({
            key: DEEP_UPDATE_REMOTE_MANIFEST_KEY,
            payload: buildManifestPayload(activeKeys),
          });
          remoteReportSignaturesRef.current = nextSignatures;
          remoteReportsAggregateSignatureRef.current = nextAggregateSignature;
          if (!warnedLargePayload) {
            setStorageNotice(null);
          }
        } catch (err) {
          if (!cancelled) {
            // Surface the actual error message so a partial-success
            // (DB persistence failed) is visible, not a generic
            // "Could not sync..." that obscures the root cause.
            const msg = err instanceof Error ? err.message : String(err);
            setStorageNotice(`Cloud sync failed: ${msg}`);
            // eslint-disable-next-line no-console
            console.error("[deepUpdate] cloud sync failed", err);
          }
        }
      })();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [authLoading, remoteHydrated, reports, reportsHydrated, user]);

  useEffect(() => {
    const flushReports = () => {
      if (!reportsHydratedRef.current) return;
      void saveDeepUpdateReportsToStorage(reportsRef.current).catch(() => {
        // Best-effort flush on navigation.
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushReports();
      }
    };

    window.addEventListener("pagehide", flushReports);
    window.addEventListener("beforeunload", flushReports);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      flushReports();
      window.removeEventListener("pagehide", flushReports);
      window.removeEventListener("beforeunload", flushReports);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const cloudSyncInFlightKeys = useMemo(
    () =>
      REPORTS.filter((report) => {
        const status = cloudSyncStatuses[report.key];
        return status?.state === "pending" || status?.state === "syncing";
      }),
    [cloudSyncStatuses]
  );
  const cloudSyncFailedKeys = useMemo(
    () => REPORTS.filter((report) => cloudSyncStatuses[report.key]?.state === "failed"),
    [cloudSyncStatuses]
  );
  const cloudSyncTotals = useMemo(() => {
    let chunksDone = 0;
    let chunksTotal = 0;
    cloudSyncInFlightKeys.forEach((report) => {
      const status = cloudSyncStatuses[report.key];
      if (status?.state === "syncing") {
        chunksDone += status.chunksDone;
        chunksTotal += status.chunksTotal;
      } else if (status?.state === "pending") {
        chunksTotal += 1;
      }
    });
    return { chunksDone, chunksTotal };
  }, [cloudSyncInFlightKeys, cloudSyncStatuses]);

  const missingRequired = useMemo(
    () => REPORTS.filter((report) => report.required && !reports[report.key]),
    [reports]
  );
  const loadedReportCount = useMemo(
    () => REPORTS.filter((report) => Boolean(reports[report.key])).length,
    [reports]
  );
  const requiredReportCount = useMemo(
    () => REPORTS.filter((report) => report.required).length,
    []
  );
  const loadedRequiredReportCount = useMemo(
    () => REPORTS.filter((report) => report.required && Boolean(reports[report.key])).length,
    [reports]
  );
  const uploadCompletionPercent = useMemo(
    () => (REPORTS.length === 0 ? 0 : (loadedReportCount / REPORTS.length) * 100),
    [loadedReportCount]
  );

  const stepDistributionRows = useMemo(() => {
    if (!result) return [] as Array<{ step: string; total: number; needsUpdate: number }>;
    const groups = new Map<string, { step: string; total: number; needsUpdate: number }>();
    result.rows.forEach((row) => {
      const step = row.calculatedStep || "Unknown";
      const current = groups.get(step) ?? { step, total: 0, needsUpdate: 0 };
      current.total += 1;
      if (row.shouldBeUpdated) current.needsUpdate += 1;
      groups.set(step, current);
    });
    return Array.from(groups.values()).sort((a, b) => b.total - a.total).slice(0, 15);
  }, [result]);

  const statusPreviewTotalRows = result?.rows.length ?? 0;
  const statusPreviewTotalPages = Math.max(1, Math.ceil(statusPreviewTotalRows / DEEP_UPDATE_PREVIEW_PAGE_SIZE));
  const statusPreviewCurrentPage = Math.min(statusPreviewPage, statusPreviewTotalPages);
  const statusPreviewStartIndex = (statusPreviewCurrentPage - 1) * DEEP_UPDATE_PREVIEW_PAGE_SIZE;
  const statusPreviewEndIndex = statusPreviewStartIndex + DEEP_UPDATE_PREVIEW_PAGE_SIZE;
  const previewRows = useMemo(
    () => (result ? result.rows.slice(statusPreviewStartIndex, statusPreviewEndIndex) : []),
    [result, statusPreviewEndIndex, statusPreviewStartIndex]
  );

  const deepUpdatePreviewTotalRows = result?.rows.length ?? 0;
  const deepUpdatePreviewTotalPages = Math.max(1, Math.ceil(deepUpdatePreviewTotalRows / DEEP_UPDATE_OUTPUT_PAGE_SIZE));
  const deepUpdatePreviewCurrentPage = Math.min(deepUpdatePreviewPage, deepUpdatePreviewTotalPages);
  const deepUpdatePreviewStartIndex = (deepUpdatePreviewCurrentPage - 1) * DEEP_UPDATE_OUTPUT_PAGE_SIZE;
  const deepUpdatePreviewEndIndex = deepUpdatePreviewStartIndex + DEEP_UPDATE_OUTPUT_PAGE_SIZE;
  const deepUpdatePreviewRows = useMemo(
    () =>
      result
        ? result.rows.slice(deepUpdatePreviewStartIndex, deepUpdatePreviewEndIndex).map((row) => row.deepUpdateRow)
        : [],
    [deepUpdatePreviewEndIndex, deepUpdatePreviewStartIndex, result]
  );
  const firstNeedsUpdateIndex = useMemo(
    () => (result ? result.rows.findIndex((row) => row.shouldBeUpdated) : -1),
    [result]
  );

  useEffect(() => {
    if (statusPreviewPage <= statusPreviewTotalPages) return;
    setStatusPreviewPage(statusPreviewTotalPages);
  }, [statusPreviewPage, statusPreviewTotalPages]);

  useEffect(() => {
    if (deepUpdatePreviewPage <= deepUpdatePreviewTotalPages) return;
    setDeepUpdatePreviewPage(deepUpdatePreviewTotalPages);
  }, [deepUpdatePreviewPage, deepUpdatePreviewTotalPages]);

  const jumpToFirstNeedsUpdate = () => {
    if (firstNeedsUpdateIndex < 0) return;
    const targetPage = Math.floor(firstNeedsUpdateIndex / DEEP_UPDATE_PREVIEW_PAGE_SIZE) + 1;
    setStatusPreviewPage(targetPage);
    if (typeof document !== "undefined") {
      document.getElementById("deep-update-status-preview")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const handleUpload = async (key: DeepUpdateReportKey, file: File | null) => {
    if (!file) return;
    setActiveUpload(key);
    setUploadErrors((previous) => ({ ...previous, [key]: undefined }));
    try {
      const parsed = await parseDeepUpdateReportFile(file, key);
      setReports((previous) => ({ ...previous, [key]: parsed }));
      setCloudSyncStatuses((previous) => ({ ...previous, [key]: { state: "pending" } }));
      setResult(null);
      setSynthError(null);
      toast.success(`${REPORTS.find((item) => item.key === key)?.label ?? key} uploaded (${parsed.rows.length} rows).`);
    } catch (error) {
      const message = toErrorMessage(error);
      setUploadErrors((previous) => ({ ...previous, [key]: message }));
      toast.error(message);
    } finally {
      setActiveUpload(null);
    }
  };

  const clearUpload = (key: DeepUpdateReportKey) => {
    setReports((previous) => ({ ...previous, [key]: undefined }));
    setCloudSyncStatuses((previous) => ({ ...previous, [key]: { state: "pending" } }));
    setUploadErrors((previous) => ({ ...previous, [key]: undefined }));
    setResult(null);
    setSynthError(null);
  };

  const runSynthesis = () => {
    setIsRunning(true);
    setSynthError(null);
    try {
      const synthesized = synthesizeDeepUpdate(reports);
      setResult(synthesized);
      setLastSuccessfulSynthesisAt(new Date());
      setStatusPreviewPage(1);
      setDeepUpdatePreviewPage(1);
      toast.success(`Synthesized ${synthesized.summary.synthesizedRows} row(s).`);
    } catch (error) {
      const message = toErrorMessage(error);
      setSynthError(message);
      toast.error(message);
    } finally {
      setIsRunning(false);
    }
  };

  // Persist the synthesized result itself (not just the inputs) so a
  // teammate can reload the run later. Each click writes a fresh
  // `deepUpdateSynthesisRuns_<timestamp>` storage key — non-
  // destructive; previous runs stay accessible by their own keys.
  const handleSaveSynthesisRun = async () => {
    if (!result) return;
    setIsSavingSynthesis(true);
    setSynthesisDbError(null);
    try {
      const runId = Date.now().toString();
      const payload = JSON.stringify(result);
      const res = await saveRemoteDatasetRef.current.mutateAsync({
        key: `deepUpdateSynthesisRuns_${runId}`,
        payload,
      });
      if (res && res.success === false && res.dbError) {
        setSynthesisDbError(res.dbError);
        toast.error("Cloud DB persistence failed.");
      } else {
        toast.success("Synthesis run saved to cloud.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to save: ${message}`);
    } finally {
      setIsSavingSynthesis(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50">
      <header className="border-b bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">Deep Update Synthesizer</h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload report files, compute Calc Step Value/Internal Status deltas, and export Deep Update CSV.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Upload Reports</CardTitle>
            <CardDescription>
              Supported file types: CSV, XLSX, XLSM. You can upload one file per report type.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {REPORTS.map((report) => {
              const uploaded = reports[report.key];
              const isBusy = activeUpload === report.key;
              const uploadError = uploadErrors[report.key];
              const cloudStatus = cloudSyncStatuses[report.key];
              return (
                <div key={report.key} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-slate-900">{report.label}</p>
                        {report.required ? (
                          <Badge className="bg-emerald-600 text-white">Required</Badge>
                        ) : (
                          <Badge variant="secondary">Optional</Badge>
                        )}
                      </div>
                      <p className="text-sm text-slate-600">{report.description}</p>
                      {uploaded ? (
                        <p className="text-xs text-slate-500">
                          Loaded: {uploaded.fileName} ({uploaded.rows.length.toLocaleString()} rows, sheet: {uploaded.sheetName})
                          {uploaded.uploadedAt > 0
                            ? ` · parsed ${new Date(uploaded.uploadedAt).toLocaleString()}`
                            : " · parsed before timestamps were tracked (re-upload to refresh)"}
                        </p>
                      ) : (
                        <p className="text-xs text-slate-500">No file uploaded yet.</p>
                      )}
                      {cloudStatus ? (
                        <p
                          className={`text-xs flex items-center gap-1 ${
                            cloudStatus.state === "failed"
                              ? "text-red-700"
                              : cloudStatus.state === "synced"
                              ? "text-emerald-700"
                              : "text-amber-700"
                          }`}
                        >
                          {cloudStatus.state === "pending" ? (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Cloud sync queued (waiting for debounce)…
                            </>
                          ) : cloudStatus.state === "syncing" ? (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Cloud sync: writing chunk {cloudStatus.chunksDone}/{cloudStatus.chunksTotal}
                            </>
                          ) : cloudStatus.state === "synced" ? (
                            <>Cloud sync: ✓ synced {new Date(cloudStatus.syncedAt).toLocaleTimeString()}</>
                          ) : (
                            <>Cloud sync failed: {cloudStatus.message}</>
                          )}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`upload-${report.key}`} className="sr-only">
                        Upload {report.label}
                      </Label>
                      <Input
                        id={`upload-${report.key}`}
                        type="file"
                        accept=".csv,.xlsx,.xlsm,.xls"
                        disabled={isBusy}
                        onChange={(event) => {
                          const file = event.target.files?.[0] ?? null;
                          void handleUpload(report.key, file);
                          event.currentTarget.value = "";
                        }}
                        className="max-w-[300px]"
                      />
                      <Button type="button" variant="outline" onClick={() => clearUpload(report.key)} disabled={!uploaded || isBusy}>
                        Clear
                      </Button>
                    </div>
                  </div>
                  {isBusy && (
                    <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Parsing file...
                    </div>
                  )}
                  {uploadError && <p className="mt-2 text-sm text-red-600">{uploadError}</p>}
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Upload Checklist</CardTitle>
            <CardDescription>
              {formatPercent(uploadCompletionPercent)} complete ({loadedReportCount}/{REPORTS.length} files loaded).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-emerald-600 transition-all"
                style={{ width: `${Math.max(0, Math.min(100, uploadCompletionPercent))}%` }}
              />
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Required Uploads</p>
                <p className="text-lg font-semibold text-slate-900">
                  {loadedRequiredReportCount}/{requiredReportCount}
                </p>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Last Successful Synthesis</p>
                <p className="text-sm font-semibold text-slate-900">
                  {lastSuccessfulSynthesisAt ? lastSuccessfulSynthesisAt.toLocaleString() : "Not run yet"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {storageNotice ? (
          <Card className="border-amber-200 bg-amber-50/70">
            <CardHeader>
              <CardTitle className="text-base text-amber-900">Storage Notice</CardTitle>
              <CardDescription className="text-amber-800">{storageNotice}</CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {cloudSyncInFlightKeys.length > 0 ? (
          <Card className="border-amber-300 bg-amber-50">
            <CardHeader>
              <CardTitle className="text-base text-amber-900 flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Cloud sync in progress — do not close this tab
              </CardTitle>
              <CardDescription className="text-amber-800">
                {cloudSyncInFlightKeys.length} report
                {cloudSyncInFlightKeys.length === 1 ? "" : "s"} still syncing
                {cloudSyncTotals.chunksTotal > 0
                  ? ` (${cloudSyncTotals.chunksDone}/${cloudSyncTotals.chunksTotal} chunks written)`
                  : ""}
                . Synthesis still works against your local data; closing now means teammates won't see the latest upload.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {cloudSyncFailedKeys.length > 0 ? (
          <Card className="border-red-300 bg-red-50">
            <CardHeader>
              <CardTitle className="text-base text-red-900">Cloud sync failed</CardTitle>
              <CardDescription className="text-red-800">
                {cloudSyncFailedKeys.map((report) => report.label).join(", ")} did not sync to cloud storage.
                Re-upload the affected file to retry. Synthesis still works against the local copy.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>2) Synthesize + Export</CardTitle>
            <CardDescription>
              Run the workbook-style logic and produce two outputs: Deep Update CSV and internal-status comparison CSV.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {missingRequired.length > 0 ? (
              <p className="text-sm text-amber-700">
                Missing required uploads: {missingRequired.map((entry) => entry.label).join(", ")}.
              </p>
            ) : (
              <p className="text-sm text-emerald-700">All required reports are loaded.</p>
            )}
            {synthError && <p className="text-sm text-red-600">{synthError}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runSynthesis} disabled={missingRequired.length > 0 || isRunning}>
                {isRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
                Run Synthesis
              </Button>
              <Button
                variant="outline"
                disabled={!result}
                onClick={() => result && triggerCsvDownload("deep-update-output.csv", result.deepUpdateCsvText)}
              >
                <Download className="h-4 w-4 mr-2" />
                Download Deep Update CSV
              </Button>
              <Button
                variant="outline"
                disabled={!result}
                onClick={() => result && triggerCsvDownload("internal-status-review.csv", result.statusCsvText)}
              >
                <Download className="h-4 w-4 mr-2" />
                Download Status Review CSV
              </Button>
              <Button
                variant="outline"
                disabled={!result || isSavingSynthesis}
                onClick={() => void handleSaveSynthesisRun()}
              >
                {isSavingSynthesis ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Database className="h-4 w-4 mr-2" />}
                Save synthesis run
              </Button>
            </div>
            {synthesisDbError && (
              <div className="mt-4 rounded-md border border-rose-300 bg-rose-50 p-3">
                <div className="flex items-center gap-2 text-rose-900 font-semibold">
                  <AlertCircle className="h-4 w-4" />
                  Cloud DB persistence failed
                </div>
                <p className="mt-1 text-xs text-rose-800 break-all">{synthesisDbError}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {result && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Summary</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-5 gap-3">
                <div className="rounded-md border border-slate-200 p-3 bg-white">
                  <p className="text-xs text-slate-500 uppercase tracking-wide">Portal Rows</p>
                  <p className="text-xl font-semibold text-slate-900">{result.summary.totalPortalRows.toLocaleString()}</p>
                </div>
                <div className="rounded-md border border-slate-200 p-3 bg-white">
                  <p className="text-xs text-slate-500 uppercase tracking-wide">Synthesized</p>
                  <p className="text-xl font-semibold text-slate-900">{result.summary.synthesizedRows.toLocaleString()}</p>
                </div>
                <div className="rounded-md border border-amber-200 p-3 bg-amber-50">
                  <p className="text-xs text-amber-700 uppercase tracking-wide">Need Update</p>
                  <p className="text-xl font-semibold text-amber-800">{result.summary.rowsNeedingUpdate.toLocaleString()}</p>
                </div>
                <div className="rounded-md border border-red-200 p-3 bg-red-50">
                  <p className="text-xs text-red-700 uppercase tracking-wide">Missing ABP</p>
                  <p className="text-xl font-semibold text-red-800">{result.summary.rowsMissingAbpMatch.toLocaleString()}</p>
                </div>
                <div className="rounded-md border border-red-200 p-3 bg-red-50">
                  <p className="text-xs text-red-700 uppercase tracking-wide">Missing ICC</p>
                  <p className="text-xl font-semibold text-red-800">{result.summary.rowsMissingIccMatch.toLocaleString()}</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Calculated Step Distribution</CardTitle>
                <CardDescription>
                  Total synthesized rows by calculated step, with rows needing update highlighted.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {stepDistributionRows.length === 0 ? (
                  <p className="text-sm text-slate-600">No synthesized rows available yet.</p>
                ) : (
                  <div className="h-72 rounded-md border border-slate-200 bg-white p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={stepDistributionRows} margin={{ top: 8, right: 12, left: 8, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="step" tick={{ fontSize: 11 }} interval={0} angle={-22} textAnchor="end" height={70} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                        <Tooltip />
                        <Bar dataKey="total" fill="#94a3b8" name="Total Rows" />
                        <Bar dataKey="needsUpdate" fill="#f59e0b" name="Needs Update" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            {result.warnings.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Warnings</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {result.warnings.map((warning) => (
                    <p key={warning} className="text-sm text-amber-700">
                      - {warning}
                    </p>
                  ))}
                  {firstNeedsUpdateIndex >= 0 ? (
                    <div>
                      <Button variant="outline" size="sm" onClick={jumpToFirstNeedsUpdate}>
                        Jump to first row needing update
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            )}

            <Card id="deep-update-status-preview">
              <CardHeader>
                <CardTitle>Status Preview</CardTitle>
                <CardDescription>
                  Use this to review where computed calc-step status differs from current internal status.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>
                    Showing {previewRows.length.toLocaleString()} of {statusPreviewTotalRows.toLocaleString()} rows
                  </span>
                  <span>
                    Page {statusPreviewCurrentPage.toLocaleString()} of {statusPreviewTotalPages.toLocaleString()}
                  </span>
                </div>
                <div className="max-h-[540px] overflow-auto rounded-md border border-slate-200">
                  <Table>
                    <TableHeader className="sticky top-0 bg-white z-10">
                      <TableRow>
                        <TableHead>Portal ID</TableHead>
                        <TableHead>System Name</TableHead>
                        <TableHead>Internal Status</TableHead>
                        <TableHead>Internal Value</TableHead>
                        <TableHead>Calculated Step</TableHead>
                        <TableHead>Calc Value</TableHead>
                        <TableHead>Should Update?</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewRows.map((row, index) => (
                        <TableRow key={`status-${row.id}-${index}`}>
                          <TableCell className="font-mono text-xs">{row.id}</TableCell>
                          <TableCell className="max-w-[260px] truncate">{row.systemName || "—"}</TableCell>
                          <TableCell className="max-w-[300px] truncate">{row.internalStatus || "—"}</TableCell>
                          <TableCell>{row.internalStatusValue ?? "—"}</TableCell>
                          <TableCell className="max-w-[320px] truncate">{row.calculatedStep}</TableCell>
                          <TableCell>{row.calcStepValue ?? "—"}</TableCell>
                          <TableCell>
                            {row.shouldBeUpdated ? (
                              <Badge className="bg-amber-500 text-amber-950">Yes</Badge>
                            ) : (
                              <Badge variant="secondary">No</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                      {previewRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-6 text-center text-slate-500">
                            No status rows to display.
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setStatusPreviewPage((page) => Math.max(1, page - 1))}
                    disabled={statusPreviewCurrentPage <= 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setStatusPreviewPage((page) => Math.min(statusPreviewTotalPages, page + 1))}
                    disabled={statusPreviewCurrentPage >= statusPreviewTotalPages}
                  >
                    Next
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Deep Update Preview</CardTitle>
                <CardDescription>
                  This mirrors the Deep Update output format: id + 10 update columns.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>
                    Showing {deepUpdatePreviewRows.length.toLocaleString()} of{" "}
                    {deepUpdatePreviewTotalRows.toLocaleString()} rows
                  </span>
                  <span>
                    Page {deepUpdatePreviewCurrentPage.toLocaleString()} of{" "}
                    {deepUpdatePreviewTotalPages.toLocaleString()}
                  </span>
                </div>
                <div className="max-h-[420px] overflow-auto rounded-md border border-slate-200">
                  <Table>
                    <TableHeader className="sticky top-0 bg-white z-10">
                      <TableRow>
                        <TableHead>id</TableHead>
                        <TableHead>est_payment_date</TableHead>
                        <TableHead>state_approval_date2</TableHead>
                        <TableHead>state_approval_date</TableHead>
                        <TableHead>standing_order_utility</TableHead>
                        <TableHead>rec_price</TableHead>
                        <TableHead>part1_submitted_date</TableHead>
                        <TableHead>part2_submitted_date</TableHead>
                        <TableHead>total_contract_amount</TableHead>
                        <TableHead>state_registration_approval_deadline</TableHead>
                        <TableHead>utility_contract_number</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {deepUpdatePreviewRows.map((row, index) => (
                        <TableRow key={`deep-${row.id}-${index}`}>
                          <TableCell className="font-mono text-xs">{row.id}</TableCell>
                          <TableCell>{row.est_payment_date}</TableCell>
                          <TableCell>{row.state_approval_date2}</TableCell>
                          <TableCell>{row.state_approval_date}</TableCell>
                          <TableCell>{row.standing_order_utility}</TableCell>
                          <TableCell>{row.rec_price}</TableCell>
                          <TableCell>{row.part1_submitted_date}</TableCell>
                          <TableCell>{row.part2_submitted_date}</TableCell>
                          <TableCell>{row.total_contract_amount}</TableCell>
                          <TableCell>{row.state_registration_approval_deadline}</TableCell>
                          <TableCell>{row.utility_contract_number}</TableCell>
                        </TableRow>
                      ))}
                      {deepUpdatePreviewRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={11} className="py-6 text-center text-slate-500">
                            No deep update rows to display.
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDeepUpdatePreviewPage((page) => Math.max(1, page - 1))}
                    disabled={deepUpdatePreviewCurrentPage <= 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDeepUpdatePreviewPage((page) => Math.min(deepUpdatePreviewTotalPages, page + 1))
                    }
                    disabled={deepUpdatePreviewCurrentPage >= deepUpdatePreviewTotalPages}
                  >
                    Next
                  </Button>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
