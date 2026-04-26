import { nanoid } from "nanoid";
import {
  eq,
  and,
  asc,
  desc,
  sql,
  getDb,
  withDbRetry,
  ensureContractScanOverrideColumns,
} from "./_core";
import {
  contractScanJobs,
  contractScanJobCsgIds,
  contractScanResults,
  InsertContractScanResult,
} from "../../drizzle/schema";

// ── Contract Scan Jobs ──────────────────────────────────────────────

export async function createContractScanJob(data: {
  userId: number;
  scopeId: string;
  totalContracts: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const id = nanoid();
  const now = new Date();
  try {
    await withDbRetry("create contract scan job", async () => {
      await db.insert(contractScanJobs).values({
        id,
        userId: data.userId,
        scopeId: data.scopeId,
        status: "queued",
        totalContracts: data.totalContracts,
        successCount: 0,
        failureCount: 0,
        currentCsgId: null,
        error: null,
        startedAt: null,
        stoppedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    console.error(`[contractScanJob] INSERT failed: code=${code} message=${msg}`, err);
    throw new Error(`Failed to create contract scan job: ${msg}`);
  }
  return id;
}

/**
 * Resolve the scopeId for a job by reading the parent
 * `contractScanJobs` row. Used by insert helpers in this module that
 * take a `jobId` but need to set `scopeId` on the new child row to
 * satisfy the post-Task-5.7-PR-A NOT NULL constraint.
 */
async function resolveScopeIdForJob(jobId: string): Promise<string> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database unavailable");
  }
  const [row] = await db
    .select({ scopeId: contractScanJobs.scopeId })
    .from(contractScanJobs)
    .where(eq(contractScanJobs.id, jobId))
    .limit(1);
  if (!row?.scopeId) {
    throw new Error(
      `Contract scan job ${jobId} has no scopeId — backfill migration may not have run`
    );
  }
  return row.scopeId;
}

export async function getContractScanJob(id: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get contract scan job", async () => {
    const [row] = await db
      .select()
      .from(contractScanJobs)
      .where(eq(contractScanJobs.id, id))
      .limit(1);
    return row ?? null;
  });
}

export async function getLatestContractScanJob(scopeId: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get latest contract scan job", async () => {
    const [row] = await db
      .select()
      .from(contractScanJobs)
      .where(eq(contractScanJobs.scopeId, scopeId))
      .orderBy(desc(contractScanJobs.createdAt))
      .limit(1);
    return row ?? null;
  });
}

export async function listContractScanJobs(
  scopeId: string,
  limit = 20
) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list contract scan jobs", async () =>
    db
      .select()
      .from(contractScanJobs)
      .where(eq(contractScanJobs.scopeId, scopeId))
      .orderBy(desc(contractScanJobs.createdAt))
      .limit(limit)
  );
}

export async function updateContractScanJob(
  id: string,
  data: Partial<{
    status:
      | "queued"
      | "running"
      | "stopping"
      | "stopped"
      | "completed"
      | "failed";
    currentCsgId: string | null;
    error: string | null;
    startedAt: Date;
    stoppedAt: Date;
    completedAt: Date;
  }>
) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("update contract scan job", async () => {
    await db
      .update(contractScanJobs)
      .set(data)
      .where(eq(contractScanJobs.id, id));
  });
}

export async function incrementContractScanJobCounter(
  id: string,
  field: "successCount" | "failureCount"
) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("increment contract scan job counter", async () => {
    await db
      .update(contractScanJobs)
      .set({
        [field]: sql`${contractScanJobs[field]} + 1`,
      })
      .where(eq(contractScanJobs.id, id));
  });
}

// ── Contract Scan Job CSG IDs ───────────────────────────────────────

export async function bulkInsertContractScanJobCsgIds(
  jobId: string,
  csgIds: string[]
) {
  const db = await getDb();
  if (!db) return;
  const scopeId = await resolveScopeIdForJob(jobId);
  // Insert in batches of 500 to avoid query size limits
  const batchSize = 500;
  for (let i = 0; i < csgIds.length; i += batchSize) {
    const batch = csgIds.slice(i, i + batchSize);
    await withDbRetry(
      `bulk insert contract scan csg ids batch ${i}`,
      async () => {
        await db.insert(contractScanJobCsgIds).values(
          batch.map((csgId) => ({
            id: nanoid(),
            jobId,
            scopeId,
            csgId,
          }))
        );
      }
    );
  }
}

// ── Contract Scan Results ───────────────────────────────────────────

export async function insertContractScanResult(
  data: InsertContractScanResult
) {
  const db = await getDb();
  if (!db) return;
  // Ensure override columns exist before inserting (they're part of the Drizzle schema now)
  await ensureContractScanOverrideColumns();
  // Truncate milliseconds from scannedAt for TiDB timestamp compatibility
  const scannedAt = data.scannedAt ? new Date(Math.floor(data.scannedAt.getTime() / 1000) * 1000) : new Date();
  const scopeId = data.scopeId ?? (await resolveScopeIdForJob(data.jobId));
  const row = {
    id: data.id ?? nanoid(),
    jobId: data.jobId,
    scopeId,
    csgId: data.csgId,
    systemName: data.systemName ?? null,
    vendorFeePercent: data.vendorFeePercent ?? null,
    additionalCollateralPercent: data.additionalCollateralPercent ?? null,
    ccAuthorizationCompleted: data.ccAuthorizationCompleted ?? null,
    additionalFivePercentSelected: data.additionalFivePercentSelected ?? null,
    ccCardAsteriskCount: data.ccCardAsteriskCount ?? null,
    paymentMethod: data.paymentMethod ?? null,
    payeeName: data.payeeName ?? null,
    mailingAddress1: data.mailingAddress1 ?? null,
    mailingAddress2: data.mailingAddress2 ?? null,
    cityStateZip: data.cityStateZip ?? null,
    recQuantity: data.recQuantity ?? null,
    recPrice: data.recPrice ?? null,
    acSizeKw: data.acSizeKw ?? null,
    dcSizeKw: data.dcSizeKw ?? null,
    pdfUrl: data.pdfUrl ?? null,
    pdfFileName: data.pdfFileName ?? null,
    error: data.error ?? null,
    scannedAt,
    overrideVendorFeePercent: data.overrideVendorFeePercent ?? null,
    overrideAdditionalCollateralPercent: data.overrideAdditionalCollateralPercent ?? null,
    overrideNotes: data.overrideNotes ?? null,
    overriddenAt: data.overriddenAt ?? null,
  };
  try {
    await withDbRetry("upsert contract scan result", async () => {
      // Check for existing row (unique on jobId+csgId) and update if found
      const existing = await db
        .select({ id: contractScanResults.id })
        .from(contractScanResults)
        .where(
          and(
            eq(contractScanResults.jobId, data.jobId),
            eq(contractScanResults.csgId, data.csgId)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        const { id: _id, jobId: _jobId, scopeId: _scopeId, csgId: _csgId, ...updateFields } = row;
        await db
          .update(contractScanResults)
          .set(updateFields)
          .where(eq(contractScanResults.id, existing[0].id));
      } else {
        await db.insert(contractScanResults).values(row);
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[contractScanResult] UPSERT failed for csgId=${data.csgId}: ${msg}`);
    throw err;
  }
}

export async function deleteContractScanJobData(jobId: string) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("delete contract scan job data", async () => {
    await db.delete(contractScanResults).where(eq(contractScanResults.jobId, jobId));
    await db.delete(contractScanJobCsgIds).where(eq(contractScanJobCsgIds.jobId, jobId));
    await db.delete(contractScanJobs).where(eq(contractScanJobs.id, jobId));
  });
}

export async function getCompletedCsgIdsForJob(
  jobId: string
): Promise<Set<string>> {
  const db = await getDb();
  if (!db) return new Set();
  return withDbRetry("get completed csg ids for job", async () => {
    const rows = await db
      .select({ csgId: contractScanResults.csgId })
      .from(contractScanResults)
      .where(
        and(
          eq(contractScanResults.jobId, jobId),
          sql`${contractScanResults.error} IS NULL`
        )
      );
    return new Set(rows.map((r) => r.csgId));
  });
}

export async function listContractScanResults(
  jobId: string,
  opts: { limit?: number; offset?: number } = {}
) {
  const db = await getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;

  return withDbRetry("list contract scan results", async () => {
    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(contractScanResults)
        .where(eq(contractScanResults.jobId, jobId))
        .orderBy(desc(contractScanResults.scannedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(contractScanResults)
        .where(eq(contractScanResults.jobId, jobId)),
    ]);
    return { rows, total: countResult[0]?.count ?? 0 };
  });
}

export async function getAllContractScanResultsForJob(jobId: string) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("get all contract scan results for job", async () =>
    db
      .select()
      .from(contractScanResults)
      .where(eq(contractScanResults.jobId, jobId))
      .orderBy(asc(contractScanResults.csgId))
  );
}

/**
 * Returns the latest successful contractScanResults row per csgId,
 * filtered to the given scope.
 *
 * Pre-Task-5.7-PR-A this function joined `contractScanJobs` and
 * filtered by `contractScanJobs.userId` for cross-tenant isolation.
 * After Task 5.7 PR-A's denormalization, `contractScanResults.scopeId`
 * is set directly on every row, so the JOIN is dropped — equivalent
 * isolation, one fewer table scanned per query.
 */
export async function getLatestScanResultsByCsgIds(
  scopeId: string,
  csgIds: string[]
) {
  const db = await getDb();
  if (!db) return [];
  if (csgIds.length === 0) return [];

  // Ensure override columns exist before querying them
  await ensureContractScanOverrideColumns();

  // Query in batches to avoid oversized IN clauses
  const batchSize = 500;
  const allResults: (typeof contractScanResults.$inferSelect)[] = [];

  for (let i = 0; i < csgIds.length; i += batchSize) {
    const batch = csgIds.slice(i, i + batchSize);
    const rows = await withDbRetry(
      `get latest scan results batch ${i}`,
      async () =>
        db
          .select()
          .from(contractScanResults)
          .where(
            and(
              eq(contractScanResults.scopeId, scopeId),
              sql`${contractScanResults.csgId} IN (${sql.join(
                batch.map((id) => sql`${id}`),
                sql`, `
              )})`,
              sql`${contractScanResults.error} IS NULL`
            )
          )
          .orderBy(desc(contractScanResults.scannedAt))
    );
    allResults.push(...rows);
  }

  // Deduplicate: keep only the latest (first by scannedAt DESC) per csgId
  const seen = new Set<string>();
  const deduped: typeof allResults = [];
  for (const row of allResults) {
    if (!seen.has(row.csgId)) {
      seen.add(row.csgId);
      deduped.push(row);
    }
  }
  return deduped;
}

// ── Contract Scan Overrides ───────────────────────────────────────

export async function updateContractScanResultOverrides(
  scopeId: string,
  csgId: string,
  overrides: {
    vendorFeePercent?: number | null;
    additionalCollateralPercent?: number | null;
    notes?: string | null;
  }
) {
  const db = await getDb();
  if (!db) return null;
  await ensureContractScanOverrideColumns();

  // Find the latest result for this scope+csgId. Post-Task-5.7-PR-A
  // contractScanResults.scopeId is denormalized so no JOIN needed.
  const results = await db
    .select({ id: contractScanResults.id })
    .from(contractScanResults)
    .where(
      and(
        eq(contractScanResults.scopeId, scopeId),
        eq(contractScanResults.csgId, csgId),
        sql`${contractScanResults.error} IS NULL`
      )
    )
    .orderBy(desc(contractScanResults.scannedAt))
    .limit(1);

  if (results.length === 0) return null;

  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  await withDbRetry("update contract scan override", async () => {
    await db
      .update(contractScanResults)
      .set({
        overrideVendorFeePercent: overrides.vendorFeePercent ?? null,
        overrideAdditionalCollateralPercent: overrides.additionalCollateralPercent ?? null,
        overrideNotes: overrides.notes ?? null,
        overriddenAt: now,
      })
      .where(eq(contractScanResults.id, results[0].id));
  });

  return { id: results[0].id, csgId, overriddenAt: now };
}
