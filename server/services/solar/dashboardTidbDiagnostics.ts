import { getDb, sql, withDbRetry } from "../../db/_core";

export const DASHBOARD_TIDB_DIAGNOSTICS_MIN_ELAPSED_MS_DEFAULT = 5_000;
export const DASHBOARD_TIDB_DIAGNOSTICS_MIN_INTERVAL_MS_DEFAULT = 30_000;
export const DASHBOARD_TIDB_DIAGNOSTICS_LIMIT_DEFAULT = 5;
export const DASHBOARD_TIDB_DIAGNOSTICS_LIMIT_MAX = 10;

type DashboardTidbDiagnosticsOutcome = "success" | "failed";

export interface DashboardTidbDiagnosticsRequest {
  path: string;
  outcome: DashboardTidbDiagnosticsOutcome;
  elapsedMs: number;
  enforcement: string;
  allowlisted: boolean;
  heapBeforeBytes: number;
  heapAfterBytes: number;
}

export interface DashboardTidbStatementSummaryRow {
  digest: string | null;
  digestText: string;
  sampleText: string;
  tableNames: string;
  execCount: number;
  avgLatencyNs: number;
  maxLatencyNs: number;
  avgProcessedKeys: number;
  maxProcessedKeys: number;
  avgTotalKeys: number;
  maxTotalKeys: number;
  avgRequestUnitRead: number;
  maxRequestUnitRead: number;
  avgRequestUnitWrite: number;
  maxRequestUnitWrite: number;
  avgQueuedRcTimeNs: number;
  maxQueuedRcTimeNs: number;
}

let lastDashboardTidbDiagnosticsAt = 0;

function parseBooleanEnv(key: string): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getNonNegativeIntegerEnv(key: string, defaultValue: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

function getBoundedPositiveIntegerEnv(
  key: string,
  defaultValue: number,
  maxValue: number
): number {
  const raw = process.env[key]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.min(Math.floor(parsed), maxValue);
}

export function getDashboardTidbDiagnosticsEnabled(): boolean {
  return parseBooleanEnv("DASHBOARD_TIDB_DIAGNOSTICS");
}

export function getDashboardTidbDiagnosticsMinElapsedMs(): number {
  return getNonNegativeIntegerEnv(
    "DASHBOARD_TIDB_DIAGNOSTICS_MIN_ELAPSED_MS",
    DASHBOARD_TIDB_DIAGNOSTICS_MIN_ELAPSED_MS_DEFAULT
  );
}

export function getDashboardTidbDiagnosticsMinIntervalMs(): number {
  return getNonNegativeIntegerEnv(
    "DASHBOARD_TIDB_DIAGNOSTICS_MIN_INTERVAL_MS",
    DASHBOARD_TIDB_DIAGNOSTICS_MIN_INTERVAL_MS_DEFAULT
  );
}

export function getDashboardTidbDiagnosticsLimit(): number {
  return getBoundedPositiveIntegerEnv(
    "DASHBOARD_TIDB_DIAGNOSTICS_LIMIT",
    DASHBOARD_TIDB_DIAGNOSTICS_LIMIT_DEFAULT,
    DASHBOARD_TIDB_DIAGNOSTICS_LIMIT_MAX
  );
}

export function resetDashboardTidbDiagnosticsThrottleForTests(): void {
  lastDashboardTidbDiagnosticsAt = 0;
}

export function shouldRunDashboardTidbDiagnostics(
  request: Pick<DashboardTidbDiagnosticsRequest, "elapsedMs">,
  now = Date.now()
): boolean {
  if (!getDashboardTidbDiagnosticsEnabled()) return false;
  if (request.elapsedMs < getDashboardTidbDiagnosticsMinElapsedMs()) {
    return false;
  }

  const minIntervalMs = getDashboardTidbDiagnosticsMinIntervalMs();
  if (
    minIntervalMs > 0 &&
    lastDashboardTidbDiagnosticsAt > 0 &&
    now - lastDashboardTidbDiagnosticsAt < minIntervalMs
  ) {
    return false;
  }

  lastDashboardTidbDiagnosticsAt = now;
  return true;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function resultRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (Array.isArray(result[0])) return result[0] as T[];
  return result as T[];
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function trimStatementText(value: unknown, maxLength = 500): string {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(maxLength - 3, 0))}...`;
}

function mapStatementSummaryRows(
  rows: Array<Record<string, unknown>>
): DashboardTidbStatementSummaryRow[] {
  return rows.map(row => ({
    digest: typeof row.digest === "string" ? row.digest : null,
    digestText: trimStatementText(row.digestText),
    sampleText: trimStatementText(row.sampleText),
    tableNames: trimStatementText(row.tableNames, 300),
    execCount: toFiniteNumber(row.execCount),
    avgLatencyNs: toFiniteNumber(row.avgLatencyNs),
    maxLatencyNs: toFiniteNumber(row.maxLatencyNs),
    avgProcessedKeys: toFiniteNumber(row.avgProcessedKeys),
    maxProcessedKeys: toFiniteNumber(row.maxProcessedKeys),
    avgTotalKeys: toFiniteNumber(row.avgTotalKeys),
    maxTotalKeys: toFiniteNumber(row.maxTotalKeys),
    avgRequestUnitRead: toFiniteNumber(row.avgRequestUnitRead),
    maxRequestUnitRead: toFiniteNumber(row.maxRequestUnitRead),
    avgRequestUnitWrite: toFiniteNumber(row.avgRequestUnitWrite),
    maxRequestUnitWrite: toFiniteNumber(row.maxRequestUnitWrite),
    avgQueuedRcTimeNs: toFiniteNumber(row.avgQueuedRcTimeNs),
    maxQueuedRcTimeNs: toFiniteNumber(row.maxQueuedRcTimeNs),
  }));
}

async function loadDashboardTidbStatementSummary(
  limit: number
): Promise<DashboardTidbStatementSummaryRow[]> {
  const db = await getDb();
  if (!db) {
    throw new Error("database unavailable");
  }

  const result = await withDbRetry(
    "load dashboard TiDB statement summary diagnostics",
    () =>
      db.execute(sql`
        SELECT
          DIGEST AS digest,
          DIGEST_TEXT AS digestText,
          QUERY_SAMPLE_TEXT AS sampleText,
          TABLE_NAMES AS tableNames,
          EXEC_COUNT AS execCount,
          AVG_LATENCY AS avgLatencyNs,
          MAX_LATENCY AS maxLatencyNs,
          AVG_PROCESSED_KEYS AS avgProcessedKeys,
          MAX_PROCESSED_KEYS AS maxProcessedKeys,
          AVG_TOTAL_KEYS AS avgTotalKeys,
          MAX_TOTAL_KEYS AS maxTotalKeys,
          AVG_REQUEST_UNIT_READ AS avgRequestUnitRead,
          MAX_REQUEST_UNIT_READ AS maxRequestUnitRead,
          AVG_REQUEST_UNIT_WRITE AS avgRequestUnitWrite,
          MAX_REQUEST_UNIT_WRITE AS maxRequestUnitWrite,
          AVG_QUEUED_RC_TIME AS avgQueuedRcTimeNs,
          MAX_QUEUED_RC_TIME AS maxQueuedRcTimeNs
        FROM information_schema.statements_summary
        WHERE SCHEMA_NAME = DATABASE()
          AND (
            LOWER(COALESCE(TABLE_NAMES, '')) LIKE '%srds%'
            OR LOWER(COALESCE(TABLE_NAMES, '')) LIKE '%solarrec%'
            OR LOWER(COALESCE(DIGEST_TEXT, '')) LIKE '%srds%'
            OR LOWER(COALESCE(DIGEST_TEXT, '')) LIKE '%solarrec%'
          )
        ORDER BY
          (COALESCE(AVG_REQUEST_UNIT_READ, 0) + COALESCE(AVG_REQUEST_UNIT_WRITE, 0)) DESC,
          AVG_LATENCY DESC
        LIMIT ${limit}
      `)
  );

  return mapStatementSummaryRows(resultRows<Record<string, unknown>>(result));
}

export async function maybeLogDashboardTidbDiagnostics(
  request: DashboardTidbDiagnosticsRequest
): Promise<void> {
  if (!shouldRunDashboardTidbDiagnostics(request)) return;

  const probeStartedAt = Date.now();
  const limit = getDashboardTidbDiagnosticsLimit();
  const basePayload = {
    path: request.path,
    outcome: request.outcome,
    elapsedMs: request.elapsedMs,
    enforcement: request.enforcement,
    allowlisted: request.allowlisted,
    heapBeforeBytes: request.heapBeforeBytes,
    heapAfterBytes: request.heapAfterBytes,
    heapDeltaBytes: request.heapAfterBytes - request.heapBeforeBytes,
    minElapsedMs: getDashboardTidbDiagnosticsMinElapsedMs(),
    minIntervalMs: getDashboardTidbDiagnosticsMinIntervalMs(),
    limit,
    source: "information_schema.statements_summary",
    requestScoped: false,
  };

  try {
    const statements = await loadDashboardTidbStatementSummary(limit);
    console.warn(
      `[dashboard:tidb-diagnostics] ${JSON.stringify({
        ...basePayload,
        available: true,
        probeElapsedMs: Date.now() - probeStartedAt,
        statementCount: statements.length,
        statements,
      })}`
    );
  } catch (error) {
    console.warn(
      `[dashboard:tidb-diagnostics] ${JSON.stringify({
        ...basePayload,
        available: false,
        probeElapsedMs: Date.now() - probeStartedAt,
        error: formatErrorMessage(error),
      })}`
    );
  }
}
