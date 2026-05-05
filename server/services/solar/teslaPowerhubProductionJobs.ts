import { nanoid } from "nanoid";
import { JOB_TTL_MS } from "../../constants";
import {
  getTeslaPowerhubProductionMetrics,
  type TeslaPowerhubApiContext,
  type TeslaPowerhubMetricsProgress,
  type TeslaPowerhubProductionMetricsResult,
} from "./teslaPowerhub";

export const TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION =
  "solar-rec-tesla-powerhub-production-job-v2";
const TESLA_POWERHUB_PRODUCTION_JOB_TIMEOUT_MS = 30 * 60 * 1000;

type TeslaPowerhubProductionJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

type TeslaPowerhubProductionResult = TeslaPowerhubProductionMetricsResult;

export type TeslaPowerhubProductionJobSnapshot = {
  id: string;
  scopeId: string;
  createdBy: number | null;
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
  result: TeslaPowerhubProductionResult | null;
  config: {
    groupId: string | null;
    endpointUrl: string | null;
    signal: string | null;
  };
  _runnerVersion: typeof TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION;
};

const teslaPowerhubProductionJobs = new Map<
  string,
  TeslaPowerhubProductionJobSnapshot
>();

function normalizeProgressPercent(currentStep: number, totalSteps: number) {
  if (totalSteps <= 0) return 0;
  return Math.max(
    0,
    Math.min(100, Math.round((currentStep / totalSteps) * 100))
  );
}

export function pruneTeslaPowerhubProductionJobs(nowMs = Date.now()): void {
  Array.from(teslaPowerhubProductionJobs.entries()).forEach(([jobId, job]) => {
    if (job.status === "queued" || job.status === "running") return;
    const updatedAtMs = Date.parse(job.updatedAt);
    if (!Number.isFinite(updatedAtMs)) return;
    if (nowMs - updatedAtMs > JOB_TTL_MS) {
      teslaPowerhubProductionJobs.delete(jobId);
    }
  });
}

export function getTeslaPowerhubProductionJobSnapshot(
  scopeId: string,
  jobId: string
): TeslaPowerhubProductionJobSnapshot | null {
  pruneTeslaPowerhubProductionJobs();
  const job = teslaPowerhubProductionJobs.get(jobId);
  if (!job || job.scopeId !== scopeId) return null;
  return job;
}

export function debugTeslaPowerhubProductionJobs(scopeId: string): {
  _runnerVersion: typeof TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION;
  jobs: Array<
    Omit<TeslaPowerhubProductionJobSnapshot, "result"> & {
      resultSiteCount: number | null;
      hasDebug: boolean;
    }
  >;
} {
  pruneTeslaPowerhubProductionJobs();
  return {
    _runnerVersion: TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION,
    jobs: Array.from(teslaPowerhubProductionJobs.values())
      .filter(job => job.scopeId === scopeId)
      .map(job => {
        const { result, ...rest } = job;
        return {
          ...rest,
          resultSiteCount: result?.sites.length ?? null,
          hasDebug: Boolean(result?.debug),
        };
      }),
  };
}

function markJob(
  jobId: string,
  updater: (
    job: TeslaPowerhubProductionJobSnapshot
  ) => TeslaPowerhubProductionJobSnapshot
): TeslaPowerhubProductionJobSnapshot | null {
  const existing = teslaPowerhubProductionJobs.get(jobId);
  if (!existing) return null;
  const next = updater(existing);
  teslaPowerhubProductionJobs.set(jobId, next);
  return next;
}

function updateProgress(
  jobId: string,
  progress: TeslaPowerhubMetricsProgress
): void {
  void markJob(jobId, job => {
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
  });
}

function formatTeslaPowerhubJobError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown job error.";
  const name = error instanceof Error ? error.name : "";
  if (
    name === "TimeoutError" ||
    /aborted due to timeout/i.test(message) ||
    /global timeout/i.test(message)
  ) {
    return `Tesla Powerhub production job exceeded ${Math.round(
      TESLA_POWERHUB_PRODUCTION_JOB_TIMEOUT_MS / 60_000
    )} minutes. Try again with a group ID or endpoint override so the job can avoid broad discovery.`;
  }
  return message;
}

export function startTeslaPowerhubProductionJob(input: {
  scopeId: string;
  createdBy: number | null;
  apiContext: TeslaPowerhubApiContext;
  groupId?: string | null;
  endpointUrl?: string | null;
  signal?: string | null;
}): TeslaPowerhubProductionJobSnapshot {
  pruneTeslaPowerhubProductionJobs();

  const nowIso = new Date().toISOString();
  const jobId = nanoid();
  const job: TeslaPowerhubProductionJobSnapshot = {
    id: jobId,
    scopeId: input.scopeId,
    createdBy: input.createdBy,
    createdAt: nowIso,
    updatedAt: nowIso,
    startedAt: null,
    finishedAt: null,
    status: "queued",
    progress: {
      currentStep: 0,
      totalSteps: 8,
      percent: 0,
      message: "Queued",
      windowKey: null,
    },
    error: null,
    result: null,
    config: {
      groupId: input.groupId ?? null,
      endpointUrl: input.endpointUrl ?? null,
      signal: input.signal ?? null,
    },
    _runnerVersion: TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION,
  };

  teslaPowerhubProductionJobs.set(jobId, job);

  void (async () => {
    markJob(jobId, current => ({
      ...current,
      status: "running",
      startedAt: current.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
      progress: {
        ...current.progress,
        message: "Starting...",
      },
    }));

    try {
      const result = await getTeslaPowerhubProductionMetrics(input.apiContext, {
        groupId: input.groupId ?? null,
        endpointUrl: input.endpointUrl ?? null,
        signal: input.signal ?? null,
        globalTimeoutMs: TESLA_POWERHUB_PRODUCTION_JOB_TIMEOUT_MS,
        onProgress: progress => updateProgress(jobId, progress),
      });

      markJob(jobId, current => ({
        ...current,
        status: "completed",
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: null,
        result,
        progress: {
          ...current.progress,
          currentStep: current.progress.totalSteps,
          percent: 100,
          message: "Completed",
          windowKey: null,
        },
      }));
    } catch (error) {
      markJob(jobId, current => ({
        ...current,
        status: "failed",
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: formatTeslaPowerhubJobError(error),
        result: null,
        progress: {
          ...current.progress,
          message: "Failed",
          windowKey: null,
        },
      }));
    }
  })();

  return job;
}

setInterval(() => pruneTeslaPowerhubProductionJobs(), 15 * 60 * 1000);
