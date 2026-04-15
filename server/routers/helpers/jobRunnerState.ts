import { toNonEmptyString } from "../../services/core/addressCleaning";
import { mapWithConcurrency } from "../../services/core/concurrency";
import { FETCH_TIMEOUT_MS, JOB_TTL_MS } from "../../constants";
import {
  getIntegrationByProvider,
  getSolarRecDashboardPayload,
  saveSolarRecDashboardPayload,
} from "../../db";
import { storageGet, storagePut } from "../../storage";
import { CsgPortalClient } from "../../services/integrations/csgPortal";
import { extractContractDataFromPdfBuffer } from "../../services/core/contractScannerServer";
import { getTeslaPowerhubGroupProductionMetrics } from "../../services/solar/teslaPowerhub";
import { CSG_PORTAL_PROVIDER } from "./constants";
import { clampPercent, normalizeProgressPercent } from "./utils";
import { parseCsgPortalMetadata } from "./providerMetadata";

// ---------------------------------------------------------------------------
// IPv4 helpers (used by Tesla Powerhub)
// ---------------------------------------------------------------------------

function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function extractIpv4FromText(value: string): string | null {
  const match = value.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (!match) return null;
  return isValidIpv4(match[0]) ? match[0] : null;
}

let cachedTeslaPowerhubEgressIpv4:
  | {
      ip: string;
      source: string;
      fetchedAt: number;
    }
  | null = null;

const TESLA_POWERHUB_EGRESS_IPV4_CACHE_MS = 5 * 60 * 1000;

export async function fetchTeslaPowerhubServerEgressIpv4(options?: {
  forceRefresh?: boolean;
}): Promise<{
  ip: string;
  cidr: string;
  source: string;
  fetchedAt: string;
  fromCache: boolean;
}> {
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    cachedTeslaPowerhubEgressIpv4 &&
    now - cachedTeslaPowerhubEgressIpv4.fetchedAt < TESLA_POWERHUB_EGRESS_IPV4_CACHE_MS
  ) {
    return {
      ip: cachedTeslaPowerhubEgressIpv4.ip,
      cidr: `${cachedTeslaPowerhubEgressIpv4.ip}/32`,
      source: cachedTeslaPowerhubEgressIpv4.source,
      fetchedAt: new Date(cachedTeslaPowerhubEgressIpv4.fetchedAt).toISOString(),
      fromCache: true,
    };
  }

  const providers: Array<{
    source: string;
    url: string;
    format: "json" | "text";
    jsonKey?: string;
  }> = [
    {
      source: "api.ipify.org",
      url: "https://api.ipify.org?format=json",
      format: "json",
      jsonKey: "ip",
    },
    {
      source: "ifconfig.me",
      url: "https://ifconfig.me/ip",
      format: "text",
    },
    {
      source: "ipv4.icanhazip.com",
      url: "https://ipv4.icanhazip.com",
      format: "text",
    },
  ];

  let lastError: string | null = null;

  for (const provider of providers) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const response = await fetch(provider.url, {
        method: "GET",
        headers: {
          Accept: provider.format === "json" ? "application/json" : "text/plain",
          "User-Agent": "coherence-rmg/tesla-powerhub-egress-check",
        },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) {
        throw new Error(`${provider.source} responded ${response.status}`);
      }

      let ip: string | null = null;
      if (provider.format === "json") {
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        ip = extractIpv4FromText(String(payload[provider.jsonKey ?? "ip"] ?? ""));
      } else {
        const text = await response.text().catch(() => "");
        ip = extractIpv4FromText(text);
      }

      if (!ip) {
        throw new Error(`${provider.source} response did not include a valid IPv4 address`);
      }

      cachedTeslaPowerhubEgressIpv4 = {
        ip,
        source: provider.source,
        fetchedAt: Date.now(),
      };

      return {
        ip,
        cidr: `${ip}/32`,
        source: provider.source,
        fetchedAt: new Date(cachedTeslaPowerhubEgressIpv4.fetchedAt).toISOString(),
        fromCache: false,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown network error";
    }
  }

  throw new Error(
    `Unable to detect server egress IPv4 address.${lastError ? ` Last error: ${lastError}` : ""}`
  );
}

// ---------------------------------------------------------------------------
// Tesla Powerhub job types and state
// ---------------------------------------------------------------------------

type TeslaPowerhubProductionJobStatus = "queued" | "running" | "completed" | "failed";

type TeslaPowerhubProductionJob = {
  id: string;
  userId: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: TeslaPowerhubProductionJobStatus;
  progress: {
    currentStep: number;
    totalSteps: number;
    percent: number;
    message: string;
    windowKey: string | null;
  };
  error: string | null;
  result: unknown | null;
  jobConfig: {
    groupId: string;
    endpointUrl: string | null;
    signal: string | null;
  } | null;
};

const TESLA_POWERHUB_PRODUCTION_JOB_TTL_MS = JOB_TTL_MS;
export const teslaPowerhubProductionJobs = new Map<string, TeslaPowerhubProductionJob>();
export const teslaPowerhubResumingJobIds = new Set<string>();

// ---------------------------------------------------------------------------
// ABP Settlement job types and state
// ---------------------------------------------------------------------------

type AbpSettlementContractScanJobStatus = "queued" | "running" | "completed" | "failed";

type AbpSettlementContractScanJobResultRow = {
  csgId: string;
  systemPageUrl: string;
  pdfUrl: string | null;
  pdfFileName: string | null;
  scan: {
    fileName: string;
    ccAuthorizationCompleted: boolean | null;
    ccCardAsteriskCount: number | null;
    additionalFivePercentSelected: boolean | null;
    additionalCollateralPercent: number | null;
    vendorFeePercent: number | null;
    systemName: string | null;
    paymentMethod: string | null;
    payeeName: string | null;
    mailingAddress1: string | null;
    mailingAddress2: string | null;
    cityStateZip: string | null;
    recQuantity: number | null;
    recPrice: number | null;
    acSizeKw: number | null;
    dcSizeKw: number | null;
  } | null;
  error: string | null;
};

export type AbpSettlementContractScanJob = {
  id: string;
  userId: number;
  scanConfig: {
    csgIds: string[];
    portalEmail: string;
    portalBaseUrl: string | null;
  };
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: AbpSettlementContractScanJobStatus;
  progress: {
    current: number;
    total: number;
    percent: number;
    message: string;
    currentCsgId: string | null;
  };
  error: string | null;
  result: {
    rows: AbpSettlementContractScanJobResultRow[];
    successCount: number;
    failureCount: number;
  };
};

type AbpSettlementSavedRunSummary = {
  runId: string;
  monthKey: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
  rowCount: number | null;
};

type AbpSettlementSavedRun = {
  summary: AbpSettlementSavedRunSummary;
  payload: string;
};

const ABP_SETTLEMENT_JOB_TTL_MS = JOB_TTL_MS;
const ABP_SETTLEMENT_SCAN_SESSION_REFRESH_INTERVAL = 80;
const ABP_SETTLEMENT_SCAN_CONCURRENCY = 3;
const ABP_SETTLEMENT_SCAN_SNAPSHOT_BATCH_SIZE = 10;
export const abpSettlementJobs = new Map<string, AbpSettlementContractScanJob>();
export const abpSettlementActiveScanRunners = new Set<string>();
const ABP_SETTLEMENT_RUNS_INDEX_DB_KEY = "abpSettlement:runs-index";

export function pruneTeslaPowerhubProductionJobs(nowMs: number): void {
  Array.from(teslaPowerhubProductionJobs.entries()).forEach(([jobId, job]) => {
    // Never prune active jobs from memory.
    if (job.status === "queued" || job.status === "running") return;
    const updatedAtMs = Date.parse(job.updatedAt);
    if (!Number.isFinite(updatedAtMs)) return;
    if (nowMs - updatedAtMs > TESLA_POWERHUB_PRODUCTION_JOB_TTL_MS) {
      teslaPowerhubProductionJobs.delete(jobId);
    }
  });
}

export function pruneAbpSettlementJobs(nowMs: number): void {
  Array.from(abpSettlementJobs.entries()).forEach(([jobId, job]) => {
    const updatedAtMs = Date.parse(job.updatedAt);
    if (!Number.isFinite(updatedAtMs)) return;
    if (nowMs - updatedAtMs > ABP_SETTLEMENT_JOB_TTL_MS) {
      abpSettlementJobs.delete(jobId);
    }
  });
}

// Periodic cleanup every 15 minutes to prevent unbounded map growth
setInterval(() => {
  const now = Date.now();
  pruneTeslaPowerhubProductionJobs(now);
  pruneAbpSettlementJobs(now);
}, 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// ABP Settlement storage helpers
// ---------------------------------------------------------------------------

function getAbpSettlementRunsIndexObjectKey(userId: number): string {
  return `abp-settlement/${userId}/runs-index.json`;
}

function getAbpSettlementRunObjectKey(userId: number, runId: string): string {
  return `abp-settlement/${userId}/runs/${runId}.json`;
}

function getAbpSettlementRunDbKey(runId: string): string {
  return `abpSettlement:run:${runId}`;
}

function getAbpSettlementScanJobObjectKey(userId: number, jobId: string): string {
  return `abp-settlement/${userId}/scan-jobs/${jobId}.json`;
}

function getAbpSettlementScanJobDbKey(jobId: string): string {
  return `abpSettlement:scanJob:${jobId}`;
}

function getTeslaPowerhubProductionJobObjectKey(userId: number, jobId: string): string {
  return `tesla-powerhub/${userId}/production-jobs/${jobId}.json`;
}

function getTeslaPowerhubProductionJobDbKey(jobId: string): string {
  return `teslaPowerhub:productionJob:${jobId}`;
}

// ---------------------------------------------------------------------------
// Read/write payload with DB+storage fallback
// ---------------------------------------------------------------------------

async function readPayloadWithFallback(input: {
  userId: number;
  objectKey: string;
  dbStorageKey: string;
}): Promise<string | null> {
  try {
    const payload = await getSolarRecDashboardPayload(input.userId, input.dbStorageKey);
    if (payload) return payload;
  } catch (error) {
    console.warn("[solarRec] DB read failed, falling through to storage:", error instanceof Error ? error.message : error);
  }

  try {
    const { url } = await storageGet(input.objectKey);
    const response = await fetch(url);
    if (!response.ok) return null;
    const payload = await response.text();
    return payload || null;
  } catch (error) {
    console.warn("[storage] Operation failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

async function writePayloadWithFallback(input: {
  userId: number;
  objectKey: string;
  dbStorageKey: string;
  payload: string;
}): Promise<{ persistedToDatabase: boolean; storageSynced: boolean }> {
  let persistedToDatabase = false;
  try {
    persistedToDatabase = await saveSolarRecDashboardPayload(
      input.userId,
      input.dbStorageKey,
      input.payload
    );
  } catch (error) {
    console.warn("[storage] DB persist failed:", error instanceof Error ? error.message : error);
    persistedToDatabase = false;
  }

  try {
    await storagePut(input.objectKey, input.payload, "application/json");
    return { persistedToDatabase, storageSynced: true };
  } catch (storageError) {
    if (persistedToDatabase) {
      return { persistedToDatabase, storageSynced: false };
    }
    throw storageError;
  }
}

// ---------------------------------------------------------------------------
// ABP Settlement run index helpers
// ---------------------------------------------------------------------------

function parseAbpSettlementRunsIndex(payload: string | null | undefined): AbpSettlementSavedRunSummary[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => {
        const row = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
        if (!row) return null;
        const runId = toNonEmptyString(row.runId);
        const monthKey = toNonEmptyString(row.monthKey);
        const createdAt = toNonEmptyString(row.createdAt);
        const updatedAt = toNonEmptyString(row.updatedAt);
        if (!runId || !monthKey || !createdAt || !updatedAt) return null;
        const rowCountRaw = row.rowCount;
        const rowCount = typeof rowCountRaw === "number" && Number.isFinite(rowCountRaw) ? rowCountRaw : null;
        return {
          runId,
          monthKey,
          label: toNonEmptyString(row.label),
          createdAt,
          updatedAt,
          rowCount,
        } satisfies AbpSettlementSavedRunSummary;
      })
      .filter((row): row is AbpSettlementSavedRunSummary => Boolean(row))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  } catch (error) {
    console.warn("[storage] Failed to list saved runs:", error instanceof Error ? error.message : error);
    return [];
  }
}

function serializeAbpSettlementRunsIndex(rows: AbpSettlementSavedRunSummary[]): string {
  return JSON.stringify(rows);
}

export async function getAbpSettlementRunsIndex(userId: number): Promise<AbpSettlementSavedRunSummary[]> {
  const payload = await readPayloadWithFallback({
    userId,
    objectKey: getAbpSettlementRunsIndexObjectKey(userId),
    dbStorageKey: ABP_SETTLEMENT_RUNS_INDEX_DB_KEY,
  });
  return parseAbpSettlementRunsIndex(payload);
}

async function saveAbpSettlementRunsIndex(
  userId: number,
  rows: AbpSettlementSavedRunSummary[]
): Promise<{ persistedToDatabase: boolean; storageSynced: boolean }> {
  const payload = serializeAbpSettlementRunsIndex(rows);
  return writePayloadWithFallback({
    userId,
    objectKey: getAbpSettlementRunsIndexObjectKey(userId),
    dbStorageKey: ABP_SETTLEMENT_RUNS_INDEX_DB_KEY,
    payload,
  });
}

export async function getAbpSettlementRun(userId: number, runId: string): Promise<AbpSettlementSavedRun | null> {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) return null;

  const index = await getAbpSettlementRunsIndex(userId);
  const summary = index.find((row) => row.runId === normalizedRunId);
  if (!summary) return null;

  const payload = await readPayloadWithFallback({
    userId,
    objectKey: getAbpSettlementRunObjectKey(userId, normalizedRunId),
    dbStorageKey: getAbpSettlementRunDbKey(normalizedRunId),
  });
  if (!payload) return null;

  return {
    summary,
    payload,
  };
}

export async function saveAbpSettlementRun(input: {
  userId: number;
  runId: string;
  monthKey: string;
  label: string | null;
  payload: string;
  rowCount: number | null;
}): Promise<{
  summary: AbpSettlementSavedRunSummary;
  indexWrite: { persistedToDatabase: boolean; storageSynced: boolean };
  runWrite: { persistedToDatabase: boolean; storageSynced: boolean };
}> {
  const nowIso = new Date().toISOString();
  const index = await getAbpSettlementRunsIndex(input.userId);
  const existing = index.find((row) => row.runId === input.runId);

  const summary: AbpSettlementSavedRunSummary = {
    runId: input.runId,
    monthKey: input.monthKey,
    label: input.label,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    rowCount: input.rowCount,
  };

  const nextIndex = [summary, ...index.filter((row) => row.runId !== input.runId)].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  );

  const runWrite = await writePayloadWithFallback({
    userId: input.userId,
    objectKey: getAbpSettlementRunObjectKey(input.userId, input.runId),
    dbStorageKey: getAbpSettlementRunDbKey(input.runId),
    payload: input.payload,
  });
  const indexWrite = await saveAbpSettlementRunsIndex(input.userId, nextIndex);

  return {
    summary,
    indexWrite,
    runWrite,
  };
}

// ---------------------------------------------------------------------------
// Tesla Powerhub job snapshot helpers
// ---------------------------------------------------------------------------

function parseTeslaPowerhubProductionJobSnapshot(
  payload: string | null | undefined
): TeslaPowerhubProductionJob | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<TeslaPowerhubProductionJob>;
    if (!parsed || typeof parsed !== "object") return null;

    const id = toNonEmptyString(parsed.id);
    const createdAt = toNonEmptyString(parsed.createdAt);
    const updatedAt = toNonEmptyString(parsed.updatedAt);
    const status = toNonEmptyString(parsed.status) as TeslaPowerhubProductionJobStatus | null;
    const userId = typeof parsed.userId === "number" && Number.isFinite(parsed.userId) ? parsed.userId : null;
    if (!id || !createdAt || !updatedAt || !status || userId === null) return null;

    const progress =
      parsed.progress && typeof parsed.progress === "object"
        ? (parsed.progress as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    const currentStep =
      typeof progress.currentStep === "number" && Number.isFinite(progress.currentStep)
        ? Math.max(0, Math.floor(progress.currentStep))
        : 0;
    const totalSteps =
      typeof progress.totalSteps === "number" && Number.isFinite(progress.totalSteps)
        ? Math.max(1, Math.floor(progress.totalSteps))
        : 1;
    const percent =
      typeof progress.percent === "number" && Number.isFinite(progress.percent)
        ? clampPercent(progress.percent)
        : normalizeProgressPercent(currentStep, totalSteps);

    return {
      id,
      userId,
      createdAt,
      updatedAt,
      startedAt: toNonEmptyString(parsed.startedAt),
      finishedAt: toNonEmptyString(parsed.finishedAt),
      status,
      progress: {
        currentStep,
        totalSteps,
        percent,
        message: toNonEmptyString(progress.message) ?? "Queued",
        windowKey: toNonEmptyString(progress.windowKey),
      },
      error: toNonEmptyString(parsed.error),
      result: parsed.result ?? null,
      jobConfig: (() => {
        const cfg = parsed.jobConfig && typeof parsed.jobConfig === "object" ? (parsed.jobConfig as Record<string, unknown>) : null;
        if (!cfg) return null;
        const groupId = toNonEmptyString(cfg.groupId);
        if (!groupId) return null;
        return {
          groupId,
          endpointUrl: toNonEmptyString(cfg.endpointUrl),
          signal: toNonEmptyString(cfg.signal),
        };
      })(),
    };
  } catch (error) {
    console.warn("[storage] Failed to parse Tesla Powerhub job snapshot:", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function saveTeslaPowerhubProductionJobSnapshot(job: TeslaPowerhubProductionJob): Promise<void> {
  const payload = JSON.stringify(job);
  await writePayloadWithFallback({
    userId: job.userId,
    objectKey: getTeslaPowerhubProductionJobObjectKey(job.userId, job.id),
    dbStorageKey: getTeslaPowerhubProductionJobDbKey(job.id),
    payload,
  });
}

export async function loadTeslaPowerhubProductionJobSnapshot(
  userId: number,
  jobId: string
): Promise<TeslaPowerhubProductionJob | null> {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) return null;

  const payload = await readPayloadWithFallback({
    userId,
    objectKey: getTeslaPowerhubProductionJobObjectKey(userId, normalizedJobId),
    dbStorageKey: getTeslaPowerhubProductionJobDbKey(normalizedJobId),
  });
  const parsed = parseTeslaPowerhubProductionJobSnapshot(payload);
  if (!parsed || parsed.userId !== userId) return null;
  return parsed;
}

/**
 * Launch the async worker that drives a Tesla Powerhub production metrics job.
 * Used both for initial job creation and for auto-resuming interrupted jobs.
 */
export function launchTeslaPowerhubProductionJobWorker(
  jobId: string,
  context: { clientId: string; clientSecret: string; tokenUrl: string | null; apiBaseUrl: string | null; portalBaseUrl: string | null },
  config: { groupId: string; endpointUrl: string | null; signal: string | null }
): void {
  void (async () => {
    let progressUpdatesSinceSnapshot = 0;

    const markJob = async (
      updater: (job: TeslaPowerhubProductionJob) => TeslaPowerhubProductionJob,
      options?: { persist?: boolean }
    ) => {
      const existing = teslaPowerhubProductionJobs.get(jobId);
      if (!existing) return null;
      const nextJob = updater(existing);
      teslaPowerhubProductionJobs.set(jobId, nextJob);

      if (options?.persist) {
        try {
          await saveTeslaPowerhubProductionJobSnapshot(nextJob);
        } catch (error) {
          console.warn(
            "[snapshot] Tesla Powerhub job snapshot write failed:",
            error instanceof Error ? error.message : error
          );
        }
      }

      return nextJob;
    };

    await markJob(
      (job) => ({
        ...job,
        status: "running",
        startedAt: job.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: null,
        progress: {
          ...job.progress,
          currentStep: 0,
          percent: 0,
          message: "Starting...",
          windowKey: null,
        },
      }),
      { persist: true }
    );

    try {
      const result = await getTeslaPowerhubGroupProductionMetrics(
        {
          clientId: context.clientId,
          clientSecret: context.clientSecret,
          tokenUrl: context.tokenUrl,
          apiBaseUrl: context.apiBaseUrl,
          portalBaseUrl: context.portalBaseUrl,
        },
        {
          groupId: config.groupId,
          endpointUrl: config.endpointUrl,
          signal: config.signal,
          onProgress: (progress) => {
            progressUpdatesSinceSnapshot += 1;
            const shouldPersist = progressUpdatesSinceSnapshot >= 25;
            if (shouldPersist) {
              progressUpdatesSinceSnapshot = 0;
            }

            void markJob(
              (job) => {
                const currentStep = Math.max(0, progress.currentStep);
                const totalSteps = Math.max(1, progress.totalSteps);
                return {
                  ...job,
                  updatedAt: new Date().toISOString(),
                  progress: {
                    currentStep,
                    totalSteps,
                    percent: normalizeProgressPercent(currentStep, totalSteps),
                    message: progress.message,
                    windowKey: progress.windowKey ?? null,
                  },
                };
              },
              { persist: shouldPersist }
            );
          },
        }
      );

      await markJob(
        (job) => ({
          ...job,
          status: "completed",
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          error: null,
          result,
          progress: {
            ...job.progress,
            currentStep: job.progress.totalSteps,
            percent: 100,
            message: "Completed",
            windowKey: null,
          },
        }),
        { persist: true }
      );
    } catch (error) {
      await markJob(
        (job) => ({
          ...job,
          status: "failed",
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : "Unknown job error.",
          result: null,
          progress: {
            ...job.progress,
            message: "Failed",
            windowKey: null,
          },
        }),
        { persist: true }
      );
    } finally {
      teslaPowerhubResumingJobIds.delete(jobId);
    }
  })();
}

// ---------------------------------------------------------------------------
// ABP Settlement scan job helpers
// ---------------------------------------------------------------------------

function parseAbpSettlementScanJobSnapshot(
  payload: string | null | undefined
): AbpSettlementContractScanJob | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<AbpSettlementContractScanJob>;
    if (!parsed || typeof parsed !== "object") return null;

    const id = toNonEmptyString(parsed.id);
    const status = toNonEmptyString(parsed.status) as AbpSettlementContractScanJobStatus | null;
    const createdAt = toNonEmptyString(parsed.createdAt);
    const updatedAt = toNonEmptyString(parsed.updatedAt);
    const scanConfig =
      parsed.scanConfig && typeof parsed.scanConfig === "object"
        ? (parsed.scanConfig as Record<string, unknown>)
        : null;
    const userId = typeof parsed.userId === "number" && Number.isFinite(parsed.userId) ? parsed.userId : null;

    if (!id || !status || !createdAt || !updatedAt || !scanConfig || userId === null) return null;

    const csgIds = Array.isArray(scanConfig.csgIds)
      ? scanConfig.csgIds.map((value) => toNonEmptyString(value)).filter((value): value is string => Boolean(value))
      : [];
    const portalEmail = toNonEmptyString(scanConfig.portalEmail);
    if (csgIds.length === 0 || !portalEmail) return null;

    const progress =
      parsed.progress && typeof parsed.progress === "object"
        ? (parsed.progress as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    const result =
      parsed.result && typeof parsed.result === "object"
        ? (parsed.result as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    const rawRows = Array.isArray(result.rows) ? result.rows : [];
    const rows = rawRows.filter(
      (value: unknown): value is AbpSettlementContractScanJobResultRow =>
        Boolean(
          value &&
            typeof value === "object" &&
            toNonEmptyString((value as Record<string, unknown>).csgId) &&
            toNonEmptyString((value as Record<string, unknown>).systemPageUrl)
        )
    );

    return {
      id,
      userId,
      scanConfig: {
        csgIds,
        portalEmail,
        portalBaseUrl: toNonEmptyString(scanConfig.portalBaseUrl),
      },
      createdAt,
      updatedAt,
      startedAt: toNonEmptyString(parsed.startedAt),
      finishedAt: toNonEmptyString(parsed.finishedAt),
      status,
      progress: {
        current:
          typeof progress.current === "number" && Number.isFinite(progress.current)
            ? Math.max(0, Math.floor(progress.current))
            : 0,
        total:
          typeof progress.total === "number" && Number.isFinite(progress.total)
            ? Math.max(1, Math.floor(progress.total))
            : Math.max(1, csgIds.length),
        percent:
          typeof progress.percent === "number" && Number.isFinite(progress.percent)
            ? clampPercent(progress.percent)
            : 0,
        message: toNonEmptyString(progress.message) ?? "Queued",
        currentCsgId: toNonEmptyString(progress.currentCsgId),
      },
      error: toNonEmptyString(parsed.error),
      result: {
        rows,
        successCount:
          typeof result.successCount === "number" && Number.isFinite(result.successCount)
            ? Math.max(0, Math.floor(result.successCount))
            : rows.filter((row) => !row.error && row.scan).length,
        failureCount:
          typeof result.failureCount === "number" && Number.isFinite(result.failureCount)
            ? Math.max(0, Math.floor(result.failureCount))
            : rows.filter((row) => Boolean(row.error) || !row.scan).length,
      },
    };
  } catch (error) {
    console.warn("[storage] Operation failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function saveAbpSettlementScanJobSnapshot(job: AbpSettlementContractScanJob): Promise<void> {
  const payload = JSON.stringify(job);
  await writePayloadWithFallback({
    userId: job.userId,
    objectKey: getAbpSettlementScanJobObjectKey(job.userId, job.id),
    dbStorageKey: getAbpSettlementScanJobDbKey(job.id),
    payload,
  });
}

export async function loadAbpSettlementScanJobSnapshot(
  userId: number,
  jobId: string
): Promise<AbpSettlementContractScanJob | null> {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) return null;
  const payload = await readPayloadWithFallback({
    userId,
    objectKey: getAbpSettlementScanJobObjectKey(userId, normalizedJobId),
    dbStorageKey: getAbpSettlementScanJobDbKey(normalizedJobId),
  });
  const parsed = parseAbpSettlementScanJobSnapshot(payload);
  if (!parsed || parsed.userId !== userId) return null;
  return parsed;
}

export async function runAbpSettlementContractScanJob(jobId: string): Promise<void> {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId || abpSettlementActiveScanRunners.has(normalizedJobId)) return;

  const initialJob = abpSettlementJobs.get(normalizedJobId);
  if (!initialJob) return;
  if (initialJob.status === "completed" || initialJob.status === "failed") return;

  abpSettlementActiveScanRunners.add(normalizedJobId);

  const markJob = async (
    updater: (job: AbpSettlementContractScanJob) => AbpSettlementContractScanJob,
    options?: { persist?: boolean }
  ): Promise<AbpSettlementContractScanJob | null> => {
    const existingJob = abpSettlementJobs.get(normalizedJobId);
    if (!existingJob) return null;
    const nextJob = updater(existingJob);
    abpSettlementJobs.set(normalizedJobId, nextJob);
    if (options?.persist) {
      try {
        await saveAbpSettlementScanJobSnapshot(nextJob);
      } catch (error) {
        console.warn("[snapshot] Best-effort snapshot write failed:", error instanceof Error ? error.message : error);
      }
    }
    return nextJob;
  };

  try {
    const currentJob = abpSettlementJobs.get(normalizedJobId);
    if (!currentJob) return;

    const integration = await getIntegrationByProvider(currentJob.userId, CSG_PORTAL_PROVIDER);
    const metadata = parseCsgPortalMetadata(integration?.metadata);
    const resolvedEmail = currentJob.scanConfig.portalEmail || metadata.email;
    const resolvedPassword = toNonEmptyString(integration?.accessToken);
    const resolvedBaseUrl = currentJob.scanConfig.portalBaseUrl ?? metadata.baseUrl;

    if (!resolvedEmail || !resolvedPassword) {
      await markJob(
        (job) => ({
          ...job,
          status: "failed",
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          error: "Missing CSG portal credentials. Save portal email/password and retry.",
          progress: {
            ...job.progress,
            message: "Failed",
            currentCsgId: null,
          },
        }),
        { persist: true }
      );
      return;
    }

    await markJob(
      (job) => ({
        ...job,
        status: "running",
        startedAt: job.startedAt ?? new Date().toISOString(),
        finishedAt: null,
        updatedAt: new Date().toISOString(),
        error: null,
        progress: {
          ...job.progress,
          total: Math.max(1, job.scanConfig.csgIds.length),
          message: "Logging into CSG portal...",
        },
      }),
      { persist: true }
    );

    const client = new CsgPortalClient({
      email: resolvedEmail,
      password: resolvedPassword,
      baseUrl: resolvedBaseUrl ?? undefined,
    });
    await client.login();

    const activeJob = abpSettlementJobs.get(normalizedJobId);
    if (!activeJob) return;

    const allIds = activeJob.scanConfig.csgIds;
    const rows = [...activeJob.result.rows];
    let successCount = Math.max(0, activeJob.result.successCount);
    let failureCount = Math.max(0, activeJob.result.failureCount);
    const processedIds = new Set(rows.map((row) => row.csgId));
    const pendingIds = allIds.filter((id) => !processedIds.has(id));

    // -- Session refresh mutex --
    let completedSinceLastRefresh = 0;
    let sessionRefreshInFlight: Promise<void> | null = null;

    const refreshSessionIfNeeded = async (): Promise<void> => {
      if (completedSinceLastRefresh < ABP_SETTLEMENT_SCAN_SESSION_REFRESH_INTERVAL) return;
      // Only one refresh at a time; other workers wait for the same promise
      if (!sessionRefreshInFlight) {
        sessionRefreshInFlight = (async () => {
          try {
            await client.login();
          } finally {
            completedSinceLastRefresh = 0;
            sessionRefreshInFlight = null;
          }
        })();
      }
      await sessionRefreshInFlight;
    };

    // -- Snapshot batching --
    let rowsSinceLastSnapshot = 0;

    const persistSnapshotIfNeeded = async (force: boolean): Promise<void> => {
      if (!force && rowsSinceLastSnapshot < ABP_SETTLEMENT_SCAN_SNAPSHOT_BATCH_SIZE) return;
      rowsSinceLastSnapshot = 0;
      await markJob(
        (job) => ({
          ...job,
          updatedAt: new Date().toISOString(),
          result: { rows: [...rows], successCount, failureCount },
          progress: {
            current: rows.length,
            total: allIds.length,
            percent: normalizeProgressPercent(rows.length, allIds.length),
            message: `Scanned ${rows.length} of ${allIds.length}`,
            currentCsgId: null,
          },
        }),
        { persist: true }
      );
    };

    // -- Process a single contract --
    const processSingleContract = async (csgId: string): Promise<void> => {
      await refreshSessionIfNeeded();

      let fetched = await client.fetchRecContractPdf(csgId);
      const fetchError = (fetched.error ?? "").toLowerCase();
      const shouldRetryAfterRefresh =
        Boolean(fetchError) &&
        (fetchError.includes("timed out") ||
          fetchError.includes("session is not authenticated") ||
          fetchError.includes("portal login"));

      if (shouldRetryAfterRefresh) {
        try {
          await client.login();
          completedSinceLastRefresh = 0;
        } catch (refreshErr) {
          console.warn(`[contractScan] Session refresh failed for ${csgId}:`, refreshErr instanceof Error ? refreshErr.message : refreshErr);
        }
        fetched = await client.fetchRecContractPdf(csgId);
      }

      let rowError = fetched.error;
      let scan: AbpSettlementContractScanJobResultRow["scan"] = null;

      if (!rowError && fetched.pdfData && fetched.pdfData.length > 0) {
        try {
          const extraction = await extractContractDataFromPdfBuffer(
            fetched.pdfData,
            fetched.pdfFileName ?? `contract-${csgId}.pdf`
          );
          scan = {
            fileName: extraction.fileName,
            ccAuthorizationCompleted: extraction.ccAuthorizationCompleted,
            ccCardAsteriskCount: extraction.ccCardAsteriskCount,
            additionalFivePercentSelected: extraction.additionalFivePercentSelected,
            additionalCollateralPercent: extraction.additionalCollateralPercent,
            vendorFeePercent: extraction.vendorFeePercent,
            systemName: extraction.systemName,
            paymentMethod: extraction.paymentMethod,
            payeeName: extraction.payeeName,
            mailingAddress1: extraction.mailingAddress1,
            mailingAddress2: extraction.mailingAddress2,
            cityStateZip: extraction.cityStateZip,
            recQuantity: extraction.recQuantity,
            recPrice: extraction.recPrice,
            acSizeKw: extraction.acSizeKw,
            dcSizeKw: extraction.dcSizeKw,
          };
        } catch (error) {
          rowError = error instanceof Error ? error.message : "Failed to parse downloaded contract PDF.";
        }
      }

      // Append result (synchronized -- JS is single-threaded between awaits)
      rows.push({
        csgId,
        systemPageUrl: fetched.systemPageUrl,
        pdfUrl: fetched.pdfUrl,
        pdfFileName: fetched.pdfFileName,
        scan,
        error: rowError,
      });

      if (rowError === null && scan) {
        successCount += 1;
      } else {
        failureCount += 1;
      }

      completedSinceLastRefresh += 1;
      rowsSinceLastSnapshot += 1;

      // Update in-memory progress after every contract (cheap, no disk I/O)
      await markJob((job) => ({
        ...job,
        updatedAt: new Date().toISOString(),
        result: { rows: [...rows], successCount, failureCount },
        progress: {
          current: rows.length,
          total: allIds.length,
          percent: normalizeProgressPercent(rows.length, allIds.length),
          message: `Scanned ${rows.length} of ${allIds.length}`,
          currentCsgId: csgId,
        },
      }));

      // Persist to disk in batches
      await persistSnapshotIfNeeded(false);
    };

    // -- Run concurrent workers --
    await markJob((job) => ({
      ...job,
      updatedAt: new Date().toISOString(),
      progress: {
        ...job.progress,
        message: `Scanning ${pendingIds.length} contracts (${ABP_SETTLEMENT_SCAN_CONCURRENCY} concurrent)...`,
      },
    }));

    await mapWithConcurrency(pendingIds, ABP_SETTLEMENT_SCAN_CONCURRENCY, async (csgId) => {
      await processSingleContract(csgId);
    });

    // Final persist
    await persistSnapshotIfNeeded(true);

    await markJob(
      (job) => ({
        ...job,
        status: "completed",
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: null,
        result: {
          rows: [...rows],
          successCount,
          failureCount,
        },
        progress: {
          current: allIds.length,
          total: allIds.length,
          percent: 100,
          message: "Completed",
          currentCsgId: null,
        },
      }),
      { persist: true }
    );
  } catch (error) {
    await markJob(
      (job) => ({
        ...job,
        status: "failed",
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown ABP settlement job error.",
        progress: {
          ...job.progress,
          message: "Failed",
          currentCsgId: null,
        },
      }),
      { persist: true }
    );
  } finally {
    abpSettlementActiveScanRunners.delete(normalizedJobId);
  }
}
