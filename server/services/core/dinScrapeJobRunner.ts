import { nanoid } from "nanoid";
import { mapWithConcurrency } from "./concurrency";
import { parseJsonMetadata } from "../../routers/helpers/utils";
import { CSG_PORTAL_PROVIDER } from "../../routers/helpers/constants";

const DIN_SCRAPE_SESSION_REFRESH_INTERVAL = 80;
const DIN_SCRAPE_CONCURRENCY = 2;
/**
 * After this many Claude/Anthropic failures in a single job, stop
 * attempting Claude for the remainder of the job and rely on
 * tesseract fallback. Prevents a prolonged Anthropic outage from
 * freezing a long job in the retry-timeout loop (60s × 3 × N photos).
 */
const CLAUDE_FAILURE_THRESHOLD = 5;
/** Bumped when the runner behavior changes — surface via getDinJobStatus. */
export const DIN_SCRAPE_RUNNER_VERSION = "din-scrape-runner@3";

const activeRunners = new Set<string>();

export async function runDinScrapeJob(jobId: string): Promise<void> {
  const id = jobId.trim();
  if (!id || activeRunners.has(id)) return;

  const {
    getDb,
    getDinScrapeJob,
    updateDinScrapeJob,
    incrementDinScrapeJobCounter,
    persistDinScrapeSiteResult,
    getCompletedCsgIdsForDinJob,
    getIntegrationByProvider,
  } = await import("../../db");

  const job = await getDinScrapeJob(id);
  if (!job) return;
  if (job.status === "completed" || job.status === "failed") return;

  activeRunners.add(id);

  try {
    const { toNonEmptyString } = await import("./addressCleaning");

    const integration = await getIntegrationByProvider(
      job.userId,
      CSG_PORTAL_PROVIDER
    );
    const metadata = parseJsonMetadata(integration?.metadata);
    const resolvedEmail = toNonEmptyString(metadata.email);
    const resolvedPassword = toNonEmptyString(integration?.accessToken);
    const resolvedBaseUrl = toNonEmptyString(metadata.baseUrl);

    if (!resolvedEmail || !resolvedPassword) {
      await updateDinScrapeJob(id, {
        status: "failed",
        error:
          "Missing CSG portal credentials. Save portal email/password and retry.",
        completedAt: new Date(),
      });
      return;
    }

    const anthropicIntegration = await getIntegrationByProvider(
      job.userId,
      "anthropic"
    );
    const anthropicApiKey = toNonEmptyString(anthropicIntegration?.accessToken);
    const anthropicMeta = parseJsonMetadata(anthropicIntegration?.metadata);
    const anthropicModel =
      typeof anthropicMeta.model === "string" && anthropicMeta.model.trim().length > 0
        ? anthropicMeta.model.trim()
        : null;

    await updateDinScrapeJob(id, {
      status: "running",
      startedAt: job.startedAt ?? new Date(),
      error: null,
      currentCsgId: null,
    });

    const { CsgPortalClient } = await import("../integrations/csgPortal");
    const { extractDinsFromPhoto } = await import("./dinExtractor");
    const client = new CsgPortalClient({
      email: resolvedEmail,
      password: resolvedPassword,
      baseUrl: resolvedBaseUrl ?? undefined,
    });
    await client.login();

    const completedIds = await getCompletedCsgIdsForDinJob(id);
    const { dinScrapeJobCsgIds } = await import("../../../drizzle/schema");
    const { eq, asc } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) {
      await updateDinScrapeJob(id, {
        status: "failed",
        error: "Database unavailable",
        completedAt: new Date(),
      });
      return;
    }

    const allIdRows = await db
      .select({ csgId: dinScrapeJobCsgIds.csgId })
      .from(dinScrapeJobCsgIds)
      .where(eq(dinScrapeJobCsgIds.jobId, id))
      .orderBy(asc(dinScrapeJobCsgIds.csgId));
    const allIds = allIdRows.map((r) => r.csgId);
    const pendingIds = allIds.filter((cid) => !completedIds.has(cid));

    if (pendingIds.length === 0) {
      await updateDinScrapeJob(id, {
        status: "completed",
        completedAt: new Date(),
        currentCsgId: null,
      });
      return;
    }

    let completedSinceLastRefresh = 0;
    let sessionRefreshInFlight: Promise<void> | null = null;

    const refreshSessionIfNeeded = async (): Promise<void> => {
      if (completedSinceLastRefresh < DIN_SCRAPE_SESSION_REFRESH_INTERVAL) return;
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

    // Circuit-breaker state for Claude/Anthropic. Shared across the
    // concurrent workers — once the failure count crosses the
    // threshold, every subsequent photo in this job skips Claude and
    // goes straight to tesseract. Concurrency-unsafe in the strict
    // sense (two workers could both observe "under threshold" and
    // increment past it), but the breaker is eventual — a few extra
    // calls past the threshold don't matter.
    let claudeFailureCount = 0;
    let claudeDisabled = false;

    let cancelled = false;
    let cancelCheckCounter = 0;
    const checkCancelled = async (): Promise<boolean> => {
      cancelCheckCounter += 1;
      if (cancelCheckCounter % 3 !== 0) return cancelled;
      const freshJob = await getDinScrapeJob(id);
      if (!freshJob || freshJob.status === "stopping") cancelled = true;
      return cancelled;
    };

    const processSingleSite = async (csgId: string): Promise<void> => {
      if (await checkCancelled()) return;

      try {
        await updateDinScrapeJob(id, { currentCsgId: csgId });
        await refreshSessionIfNeeded();

        let fetched = await client.fetchSystemPhotos(csgId);
        const fetchError = (fetched.error ?? "").toLowerCase();
        const shouldRetry =
          Boolean(fetchError) &&
          (fetchError.includes("timed out") ||
            fetchError.includes("session is not authenticated") ||
            fetchError.includes("portal login"));
        if (shouldRetry) {
          try {
            await client.login();
            completedSinceLastRefresh = 0;
          } catch (err) {
            console.warn(
              `[dinScrapeJob] Session refresh failed for ${csgId}:`,
              err instanceof Error ? err.message : err
            );
          }
          fetched = await client.fetchSystemPhotos(csgId);
        }

        const siteError = fetched.error;
        let inverterCount = 0;
        let meterCount = 0;
        const allDins: Array<{
          dinValue: string;
          rawMatch: string;
          extractedBy: "claude" | "tesseract" | "pdfjs";
          sourceType: "inverter" | "meter" | "unknown";
          sourceUrl: string;
          sourceFileName: string;
        }> = [];

        if (!siteError && fetched.photos.length > 0) {
          for (const photo of fetched.photos) {
            if (photo.sourceType === "inverter") inverterCount += 1;
            else if (photo.sourceType === "meter") meterCount += 1;
            try {
              // Pass null apiKey once the breaker has tripped so the
              // extractor skips Claude entirely (no timeout burn).
              const effectiveApiKey = claudeDisabled ? null : anthropicApiKey;
              const result = await extractDinsFromPhoto(
                photo.data,
                photo.mimeType,
                { anthropicApiKey: effectiveApiKey, anthropicModel }
              );
              if (result.claudeFailed) {
                claudeFailureCount += 1;
                if (!claudeDisabled && claudeFailureCount >= CLAUDE_FAILURE_THRESHOLD) {
                  claudeDisabled = true;
                  console.warn(
                    `[dinScrapeJob] Disabling Claude for job ${id} after ${claudeFailureCount} failures; rest of job will use tesseract only.`
                  );
                }
              }
              for (const match of result.dins) {
                allDins.push({
                  dinValue: match.dinValue,
                  rawMatch: match.rawMatch,
                  extractedBy: match.extractedBy,
                  sourceType: photo.sourceType,
                  sourceUrl: photo.url,
                  sourceFileName: photo.fileName,
                });
              }
            } catch (err) {
              console.warn(
                `[dinScrapeJob] Extraction failed for ${csgId} ${photo.url}:`,
                err instanceof Error ? err.message : err
              );
            }
          }
        }

        // Collapse duplicates across photos — same DIN can appear on
        // multiple angles of the same inverter.
        const seen = new Set<string>();
        const deduped = allDins.filter((d) => {
          if (seen.has(d.dinValue)) return false;
          seen.add(d.dinValue);
          return true;
        });

        try {
          // Single atomic write: upsert result row AND replace din rows
          // inside one withDbRetry. Prevents the stale-result-row bug
          // where the summary claims N dins but no dins were persisted.
          await persistDinScrapeSiteResult({
            result: {
              id: nanoid(),
              jobId: id,
              csgId,
              systemPageUrl: fetched.systemPageUrl,
              inverterPhotoCount: inverterCount,
              meterPhotoCount: meterCount,
              dinCount: deduped.length,
              error: siteError ?? null,
              scannedAt: new Date(),
            },
            dins: deduped.map((d) => ({
              id: nanoid(),
              jobId: id,
              csgId,
              dinValue: d.dinValue,
              sourceType: d.sourceType,
              sourceUrl: d.sourceUrl,
              sourceFileName: d.sourceFileName,
              extractedBy: d.extractedBy,
              rawMatch: d.rawMatch,
              foundAt: new Date(),
            })),
          });
        } catch (dbErr) {
          console.warn(
            `[dinScrapeJob] DB write failed for ${csgId}, skipping:`,
            dbErr instanceof Error ? dbErr.message : dbErr
          );
        }

        // Accounting: a site is either processed (no portal error) or
        // failed. "Zero DINs found" is still a successful scan — the
        // dinCount column already tells that story; conflating it with
        // failure misleads the UI. The dinCount per site is the truth.
        if (siteError) {
          await incrementDinScrapeJobCounter(id, "failureCount");
        } else {
          await incrementDinScrapeJobCounter(id, "successCount");
        }

        completedSinceLastRefresh += 1;
      } catch (err) {
        console.warn(
          `[dinScrapeJob] Skipping ${csgId} due to error:`,
          err instanceof Error ? err.message : err
        );
        try {
          await incrementDinScrapeJobCounter(id, "failureCount");
        } catch {
          /* ignore */
        }
      }
    };

    await mapWithConcurrency(
      pendingIds,
      DIN_SCRAPE_CONCURRENCY,
      async (csgId) => {
        await processSingleSite(csgId);
      }
    );

    if (cancelled) {
      await updateDinScrapeJob(id, {
        status: "stopped",
        stoppedAt: new Date(),
        currentCsgId: null,
      });
    } else {
      await updateDinScrapeJob(id, {
        status: "completed",
        completedAt: new Date(),
        currentCsgId: null,
      });
    }
  } catch (error) {
    try {
      await updateDinScrapeJob(id, {
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : "Unknown DIN scrape job error.",
        completedAt: new Date(),
        currentCsgId: null,
      });
    } catch {
      // Best effort.
    }
  } finally {
    activeRunners.delete(id);
  }
}

export function isDinScrapeRunnerActive(jobId: string): boolean {
  return activeRunners.has(jobId);
}
