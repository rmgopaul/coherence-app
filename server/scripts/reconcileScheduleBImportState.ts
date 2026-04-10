import { asc, eq } from "drizzle-orm";
import { getDb, reconcileScheduleBImportJobState } from "../db";
import { scheduleBImportJobs } from "../../drizzle/schema";

type ScriptFilters = {
  jobId: string | null;
  userId: number | null;
};

function parseArgs(argv: string[]): ScriptFilters {
  let jobId: string | null = null;
  let userId: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--job-id" && argv[index + 1]) {
      jobId = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (token === "--user-id" && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        userId = Math.trunc(parsed);
      }
      index += 1;
    }
  }

  return { jobId, userId };
}

async function main() {
  const filters = parseArgs(process.argv.slice(2));
  const db = await getDb();
  if (!db) {
    throw new Error("Database unavailable. Check DATABASE_URL and retry.");
  }

  const jobs = filters.jobId
    ? await db
        .select()
        .from(scheduleBImportJobs)
        .where(eq(scheduleBImportJobs.id, filters.jobId))
    : filters.userId
      ? await db
          .select()
          .from(scheduleBImportJobs)
          .where(eq(scheduleBImportJobs.userId, filters.userId))
          .orderBy(asc(scheduleBImportJobs.createdAt))
      : await db
          .select()
          .from(scheduleBImportJobs)
          .orderBy(asc(scheduleBImportJobs.createdAt));

  if (jobs.length === 0) {
    console.log("No Schedule B import jobs found for the provided filters.");
    return;
  }

  let jobsTouched = 0;
  let filesCorrected = 0;
  let filesRequeued = 0;

  for (const job of jobs) {
    const beforeTotal = job.totalFiles ?? 0;
    const beforeSuccess = job.successCount ?? 0;
    const beforeFailure = job.failureCount ?? 0;

    const result = await reconcileScheduleBImportJobState(job.id);
    const countersChanged =
      beforeTotal !== result.totalFiles ||
      beforeSuccess !== result.successCount ||
      beforeFailure !== result.failureCount;

    if (result.filesMarkedCompleted > 0 || result.filesRequeued > 0 || countersChanged) {
      jobsTouched += 1;
    }
    filesCorrected += result.filesMarkedCompleted;
    filesRequeued += result.filesRequeued;

    console.log(
      `[schedule-b-reconcile] job=${job.id} user=${job.userId} corrected=${result.filesMarkedCompleted} requeued=${result.filesRequeued} counters=${beforeTotal}/${beforeSuccess}/${beforeFailure}->${result.totalFiles}/${result.successCount}/${result.failureCount}`
    );
  }

  console.log(
    `Migration complete: jobs touched=${jobsTouched}, files corrected=${filesCorrected}, files requeued=${filesRequeued}.`
  );
}

void main().catch((error) => {
  console.error(
    "[schedule-b-reconcile] Failed:",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});
