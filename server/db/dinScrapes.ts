import { nanoid } from "nanoid";
import {
  eq,
  and,
  asc,
  desc,
  sql,
  inArray,
  getDb,
  withDbRetry,
} from "./_core";
import {
  dinScrapeJobs,
  dinScrapeJobCsgIds,
  dinScrapeResults,
  dinScrapeDins,
  DinScrapeJob,
  InsertDinScrapeResult,
  InsertDinScrapeDin,
} from "../../drizzle/schema";

export type DinScrapeJobWithCounts = DinScrapeJob & { totalDins: number };

// ── Jobs ──────────────────────────────────────────────────────────

export async function createDinScrapeJob(data: {
  userId: number;
  totalSites: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const id = nanoid();
  const now = new Date();
  await withDbRetry("create din scrape job", async () => {
    await db.insert(dinScrapeJobs).values({
      id,
      userId: data.userId,
      status: "queued",
      totalSites: data.totalSites,
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
  return id;
}

export async function getDinScrapeJob(id: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get din scrape job", async () => {
    const [row] = await db
      .select()
      .from(dinScrapeJobs)
      .where(eq(dinScrapeJobs.id, id))
      .limit(1);
    return row ?? null;
  });
}

export async function listDinScrapeJobs(
  userId: number,
  limit = 20
): Promise<DinScrapeJobWithCounts[]> {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list din scrape jobs", async () => {
    const jobs = await db
      .select()
      .from(dinScrapeJobs)
      .where(eq(dinScrapeJobs.userId, userId))
      .orderBy(desc(dinScrapeJobs.createdAt))
      .limit(limit);
    if (jobs.length === 0) return [];

    // One aggregate query to attach totalDins per job — so the job
    // history table can show "47 DINs extracted" alongside the
    // per-site success/failure counts. Using COUNT(*) on the dins
    // table is the source of truth (the dinCount column on results
    // is kept in sync but we count rows directly for safety).
    const jobIds = jobs.map((j) => j.id);
    const counts = await db
      .select({
        jobId: dinScrapeDins.jobId,
        total: sql<number>`COUNT(*)`,
      })
      .from(dinScrapeDins)
      .where(inArray(dinScrapeDins.jobId, jobIds))
      .groupBy(dinScrapeDins.jobId);
    const countMap = new Map(
      counts.map((c) => [c.jobId, Number(c.total) || 0])
    );
    return jobs.map((j) => ({ ...j, totalDins: countMap.get(j.id) ?? 0 }));
  });
}

export async function updateDinScrapeJob(
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
  await withDbRetry("update din scrape job", async () => {
    await db.update(dinScrapeJobs).set(data).where(eq(dinScrapeJobs.id, id));
  });
}

export async function incrementDinScrapeJobCounter(
  id: string,
  field: "successCount" | "failureCount"
) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("increment din scrape job counter", async () => {
    await db
      .update(dinScrapeJobs)
      .set({
        [field]: sql`${dinScrapeJobs[field]} + 1`,
      })
      .where(eq(dinScrapeJobs.id, id));
  });
}

// ── CSG ID input list ────────────────────────────────────────────

export async function bulkInsertDinScrapeJobCsgIds(
  jobId: string,
  csgIds: string[]
) {
  const db = await getDb();
  if (!db) {
    // Silent no-op would let the runner think 0 IDs were queued and
    // mark the whole job as completed with no work done. Better to
    // surface the outage immediately so the caller fails the job.
    throw new Error("Database unavailable while inserting DIN scrape CSG IDs");
  }
  const batchSize = 500;
  for (let i = 0; i < csgIds.length; i += batchSize) {
    const batch = csgIds.slice(i, i + batchSize);
    await withDbRetry(
      `bulk insert din scrape csg ids batch ${i}`,
      async () => {
        await db.insert(dinScrapeJobCsgIds).values(
          batch.map((csgId) => ({
            id: nanoid(),
            jobId,
            csgId,
          }))
        );
      }
    );
  }
}

// ── Per-site results ─────────────────────────────────────────────

/**
 * Upsert the per-site summary row and replace all DIN rows for that
 * site, inside a single withDbRetry block. Replacing the previous
 * two separate calls — the old shape could leave a result row with
 * `dinCount = N` but zero dinScrapeDins rows if the second insert
 * failed after the first succeeded.
 */
export async function persistDinScrapeSiteResult(input: {
  result: InsertDinScrapeResult;
  dins: InsertDinScrapeDin[];
}) {
  const db = await getDb();
  if (!db) return;

  const { result, dins } = input;
  const scannedAt = result.scannedAt
    ? new Date(Math.floor(result.scannedAt.getTime() / 1000) * 1000)
    : new Date();
  const resultRow = {
    id: result.id ?? nanoid(),
    jobId: result.jobId,
    csgId: result.csgId,
    systemPageUrl: result.systemPageUrl ?? null,
    inverterPhotoCount: result.inverterPhotoCount ?? 0,
    meterPhotoCount: result.meterPhotoCount ?? 0,
    dinCount: result.dinCount ?? 0,
    steId: result.steId ?? null,
    error: result.error ?? null,
    extractorLog: result.extractorLog ?? null,
    scannedAt,
  };

  await withDbRetry("persist din scrape site result", async () => {
    const existing = await db
      .select({ id: dinScrapeResults.id })
      .from(dinScrapeResults)
      .where(
        and(
          eq(dinScrapeResults.jobId, result.jobId),
          eq(dinScrapeResults.csgId, result.csgId)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      const { id: _id, jobId: _jobId, csgId: _csgId, ...updateFields } =
        resultRow;
      await db
        .update(dinScrapeResults)
        .set(updateFields)
        .where(eq(dinScrapeResults.id, existing[0].id));
    } else {
      await db.insert(dinScrapeResults).values(resultRow);
    }

    // Always replace dins for this site — on re-scan the old rows are
    // stale; on first write this is a no-op.
    await db
      .delete(dinScrapeDins)
      .where(
        and(
          eq(dinScrapeDins.jobId, result.jobId),
          eq(dinScrapeDins.csgId, result.csgId)
        )
      );

    if (dins.length > 0) {
      await db.insert(dinScrapeDins).values(
        dins.map((r) => ({
          id: r.id ?? nanoid(),
          jobId: r.jobId,
          csgId: r.csgId,
          dinValue: r.dinValue,
          sourceType: r.sourceType ?? "unknown",
          sourceUrl: r.sourceUrl ?? null,
          sourceFileName: r.sourceFileName ?? null,
          extractedBy: r.extractedBy ?? "claude",
          rawMatch: r.rawMatch ?? null,
          foundAt: r.foundAt ?? new Date(),
        }))
      );
    }
  });
}

export async function getCompletedCsgIdsForDinJob(
  jobId: string
): Promise<Set<string>> {
  const db = await getDb();
  if (!db) return new Set();
  return withDbRetry("get completed din csg ids", async () => {
    const rows = await db
      .select({ csgId: dinScrapeResults.csgId })
      .from(dinScrapeResults)
      .where(
        and(
          eq(dinScrapeResults.jobId, jobId),
          sql`${dinScrapeResults.error} IS NULL`
        )
      );
    return new Set(rows.map((r) => r.csgId));
  });
}

export async function listDinScrapeResults(
  jobId: string,
  opts: { limit?: number; offset?: number } = {}
) {
  const db = await getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;

  return withDbRetry("list din scrape results", async () => {
    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(dinScrapeResults)
        .where(eq(dinScrapeResults.jobId, jobId))
        .orderBy(desc(dinScrapeResults.scannedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(dinScrapeResults)
        .where(eq(dinScrapeResults.jobId, jobId)),
    ]);
    return { rows, total: countResult[0]?.count ?? 0 };
  });
}

export async function listDinScrapeDinsForJob(
  jobId: string,
  opts: { limit?: number; offset?: number } = {}
) {
  const db = await getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = opts.limit ?? 500;
  const offset = opts.offset ?? 0;

  return withDbRetry("list din scrape dins", async () => {
    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(dinScrapeDins)
        .where(eq(dinScrapeDins.jobId, jobId))
        .orderBy(asc(dinScrapeDins.csgId), asc(dinScrapeDins.dinValue))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(dinScrapeDins)
        .where(eq(dinScrapeDins.jobId, jobId)),
    ]);
    return { rows, total: countResult[0]?.count ?? 0 };
  });
}

export async function getAllDinScrapeDinsForJob(jobId: string) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("get all din scrape dins for job", async () =>
    db
      .select()
      .from(dinScrapeDins)
      .where(eq(dinScrapeDins.jobId, jobId))
      .orderBy(asc(dinScrapeDins.csgId), asc(dinScrapeDins.dinValue))
  );
}

/**
 * Raw DB snapshot for a job — mirror of the Schedule B debug helper.
 * Returns the job row, its input CSG IDs, the per-site result rows,
 * and the extracted DIN rows. Capped counts so the response stays
 * bounded even for large jobs.
 */
export async function getDinScrapeDebugSnapshot(jobId: string) {
  const db = await getDb();
  if (!db) {
    return {
      ok: false as const,
      error: "Database unavailable",
    };
  }
  return withDbRetry("din scrape debug snapshot", async () => {
    const [jobRow] = await db
      .select()
      .from(dinScrapeJobs)
      .where(eq(dinScrapeJobs.id, jobId))
      .limit(1);
    if (!jobRow) {
      return { ok: false as const, error: "Job not found" };
    }
    const csgIdRows = await db
      .select()
      .from(dinScrapeJobCsgIds)
      .where(eq(dinScrapeJobCsgIds.jobId, jobId))
      .orderBy(asc(dinScrapeJobCsgIds.csgId))
      .limit(2000);
    const resultRows = await db
      .select()
      .from(dinScrapeResults)
      .where(eq(dinScrapeResults.jobId, jobId))
      .orderBy(desc(dinScrapeResults.scannedAt))
      .limit(500);
    const dinRows = await db
      .select()
      .from(dinScrapeDins)
      .where(eq(dinScrapeDins.jobId, jobId))
      .orderBy(asc(dinScrapeDins.csgId), asc(dinScrapeDins.dinValue))
      .limit(2000);
    return {
      ok: true as const,
      job: jobRow,
      csgIdCount: csgIdRows.length,
      csgIds: csgIdRows,
      resultCount: resultRows.length,
      results: resultRows,
      dinCount: dinRows.length,
      dins: dinRows,
      snapshotAt: new Date().toISOString(),
    };
  });
}

export async function deleteDinScrapeJobData(jobId: string) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("delete din scrape job data", async () => {
    await db.delete(dinScrapeDins).where(eq(dinScrapeDins.jobId, jobId));
    await db.delete(dinScrapeResults).where(eq(dinScrapeResults.jobId, jobId));
    await db
      .delete(dinScrapeJobCsgIds)
      .where(eq(dinScrapeJobCsgIds.jobId, jobId));
    await db.delete(dinScrapeJobs).where(eq(dinScrapeJobs.id, jobId));
  });
}
