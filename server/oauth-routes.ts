import { Router, type Request } from "express";
import { nanoid } from "nanoid";
import {
  upsertIntegration,
  getOAuthCredential,
  getIntegrationByProvider,
  addSamsungSyncPayload,
  getLatestSamsungSyncPayload,
  upsertSamsungDailyMetric,
  getDailyMetricsHistory,
  getDb,
} from "./db";
import { samsungSyncPayloads } from "../drizzle/schema";
import { and, desc, eq } from "drizzle-orm";
import { exchangeGoogleCode } from "./services/integrations/google";
import { exchangeWhoopCode } from "./services/integrations/whoop";
import { sdk } from "./_core/sdk";
import { ENV } from "./_core/env";
import crypto from "crypto";

/**
 * Version marker for the Samsung Health webhook handlers. Bump this
 * string whenever you deploy a behavior change to the ingest pipeline,
 * then curl the debug endpoint after a deploy to verify the string
 * has rolled through. Follows the `_runnerVersion` / `_checkpoint`
 * pattern documented in `docs/server-routing.md` and mirrored by the
 * Schedule B import routes.
 */
const SAMSUNG_HEALTH_WEBHOOK_VERSION = "samsung-webhook-v2-2026-04-14" as const;

const router = Router();

// In-memory store for OAuth state (in production, use Redis or database)
const oauthStates = new Map<string, { userId: number; timestamp: number }>();

// Clean up expired states every 10 minutes
setInterval(() => {
  const now = Date.now();
  const entries = Array.from(oauthStates.entries());
  for (const [state, data] of entries) {
    if (now - data.timestamp > 10 * 60 * 1000) { // 10 minutes
      oauthStates.delete(state);
    }
  }
}, 10 * 60 * 1000);

// Helper to get the base URL for OAuth callbacks
function getBaseUrl(req: Request): string {
  // Use published URL if available (for production), otherwise fall back to dynamic host (for dev)
  const baseUrl = ENV.publishedUrl || `${req.protocol}://${req.get("host")}`;
  // Remove trailing slash to prevent double slashes in redirect URIs
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function safeTimingEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function listCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function extractStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isDegradedSamsungSync(payloadSync: Record<string, unknown>, warnings: string[]): boolean {
  const permissionsGranted = payloadSync.permissionsGranted;
  const sdkLinked = payloadSync.sdkLinked;
  const warningIndicatesFailure = warnings.some((warning) =>
    /(read failed|permission|foreground|missing permissions|error|failed|not granted)/i.test(warning)
  );
  return permissionsGranted === false || sdkLinked === false || warningIndicatesFailure;
}

type SamsungManualScores = {
  sleepScore: number | null;
  energyScore: number | null;
};

function toNullableManualScore(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(100, Math.max(0, value));
  }
  return null;
}

function parseSamsungManualScores(metadata: string | null | undefined): SamsungManualScores | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (!parsed || typeof parsed !== "object") return null;
    const manual = (parsed as { manualScores?: unknown }).manualScores;
    if (!manual || typeof manual !== "object" || Array.isArray(manual)) return null;
    const manualRecord = manual as Record<string, unknown>;
    return {
      sleepScore: toNullableManualScore(manualRecord.sleepScore),
      energyScore: toNullableManualScore(manualRecord.energyScore),
    };
  } catch {
    return null;
  }
}

function buildSamsungMetadata(
  payload: unknown,
  receivedAt: string,
  manualScores?: SamsungManualScores | null,
  options?: {
    previousSummary?: Record<string, unknown>;
    preservePreviousIfDegraded?: boolean;
  }
): string {
  const root = asRecord(payload);
  const activity = asRecord(root.activity);
  const sleep = asRecord(root.sleep);
  const cardio = asRecord(root.cardio);
  const oxygenAndTemperature = asRecord(root.oxygenAndTemperature);
  const bodyComposition = asRecord(root.bodyComposition);
  const nutrition = asRecord(root.nutrition);
  const hydration = asRecord(root.hydration);
  const samples = asRecord(root.samples);
  const sync = asRecord(root.sync);
  const source = asRecord(root.source);

  const summary: Record<string, unknown> = {
    date: asString(root.date),
    capturedAtIso: asString(root.capturedAtIso),
    timezone: asString(root.timezone),
    sourceProvider: asString(source.provider),
    steps: asNumber(activity.steps),
    activeMinutes: asNumber(activity.activeMinutes),
    caloriesTotalKcal: asNumber(activity.caloriesTotalKcal),
    sleepTotalMinutes: asNumber(sleep.totalSleepMinutes),
    // Manual scores only — no heuristic fallback. The Android mapper's
    // `deriveSleepScore` produces a decimal (e.g. 82.4) computed from
    // efficiency + deep/REM ratio + duration. Samsung's actual UI score
    // is an integer the user might enter manually; falling back to the
    // heuristic stamps decimals onto historical rows the user never
    // entered, which looks like garbage in the dashboard. If no manual
    // score exists for the date, leave the field null. `cardio.recoveryScore`
    // is never populated anyway (the Android `CardioMetrics` data class
    // has no recoveryScore field), so the energyScore line was already
    // effectively `?? null`.
    sleepScore: manualScores?.sleepScore ?? null,
    energyScore: manualScores?.energyScore ?? null,
    restingHeartRateBpm: asNumber(cardio.restingHeartRateBpm),
    hrvRmssdMs: asNumber(cardio.hrvRmssdMs),
    spo2AvgPercent: asNumber(oxygenAndTemperature.spo2AvgPercent),
    weightKg: asNumber(bodyComposition.weightKg),
    caloriesIntakeKcal: asNumber(nutrition.caloriesIntakeKcal),
    waterMl: asNumber(hydration.waterMl),
    workoutsCount: listCount(samples.workouts),
    sleepSessionsCount: listCount(samples.sleepSessions),
    sleepStageSamplesCount: listCount(samples.sleepStageSeries),
    heartRateSamplesCount: listCount(samples.heartRateSeries),
    spo2SamplesCount: listCount(samples.spo2Series),
    bloodPressureSamplesCount: listCount(samples.bloodPressureSeries),
    glucoseSamplesCount: listCount(samples.glucoseSeries),
    // Record-type coverage counts — used by the dashboard card to
    // render "18/22 data types" coverage pills. Driven straight from
    // the Android payload's sync.recordTypesAttempted /
    // .recordTypesSucceeded arrays.
    recordTypesAttempted: Array.isArray(sync.recordTypesAttempted)
      ? (sync.recordTypesAttempted as unknown[]).length
      : null,
    recordTypesSucceeded: Array.isArray(sync.recordTypesSucceeded)
      ? (sync.recordTypesSucceeded as unknown[]).length
      : null,
  };

  if (options?.preservePreviousIfDegraded && options.previousSummary) {
    const previousSummary = options.previousSummary;
    const preserveWhenIncomingMissingOrZero = [
      "steps",
      "sleepTotalMinutes",
      "sleepScore",
      "energyScore",
      "restingHeartRateBpm",
      "hrvRmssdMs",
      "spo2AvgPercent",
      "sleepSessionsCount",
      "sleepStageSamplesCount",
      "heartRateSamplesCount",
      "spo2SamplesCount",
    ];
    for (const key of preserveWhenIncomingMissingOrZero) {
      const incomingValue = asNumber(summary[key]);
      const previousValue = asNumber(previousSummary[key]);
      if (previousValue !== null && (incomingValue === null || incomingValue <= 0)) {
        summary[key] = previousValue;
      }
    }
  }

  return JSON.stringify({
    schemaVersion: 1,
    provider: "samsung-health",
    receivedAt,
    summary,
    manualScores: manualScores ?? undefined,
    sync,
  });
}

// Google OAuth initiation
router.get("/oauth/google", async (req, res) => {
  try {
    // Authenticate user first
    const user = await sdk.authenticateRequest(req);
    if (!user?.id) {
      return res.redirect("/settings?error=google&message=not_authenticated");
    }

    // Get OAuth credentials from database
    const creds = await getOAuthCredential(user.id, "google");
    
    if (!creds?.clientId) {
      return res.redirect("/settings?error=google&message=credentials_not_configured");
    }
    
    const clientId = creds.clientId;

    // Generate state parameter to maintain user context
    const state = crypto.randomBytes(32).toString("hex");
    oauthStates.set(state, { userId: user.id, timestamp: Date.now() });

    const redirectUri = `${getBaseUrl(req)}/api/oauth/google/callback`;
    const scope = [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/spreadsheets",
      "openid",
      "email",
      "profile",
    ].join(" ");

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      state,
    })}`;

    res.redirect(authUrl);
  } catch (error) {
    console.error("Google OAuth initiation error:", error);
    res.redirect("/settings?error=google&message=initiation_failed");
  }
});

// Google OAuth callback
router.get("/oauth/google/callback", async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    return res.redirect(`/settings?error=google&message=${error}`);
  }

  if (!code || !state) {
    return res.redirect("/settings?error=google&message=no_code_or_state");
  }

  try {
    // Retrieve user ID from state
    const stateData = oauthStates.get(state as string);
    if (!stateData) {
      return res.redirect("/settings?error=google&message=invalid_state");
    }

    // Clean up used state
    oauthStates.delete(state as string);

    const userId = stateData.userId;

    // Get OAuth credentials from database
    const creds = await getOAuthCredential(userId, "google");
    if (!creds?.clientId || !creds?.clientSecret) {
      return res.redirect("/settings?error=google&message=credentials_not_configured");
    }

    const redirectUri = `${getBaseUrl(req)}/api/oauth/google/callback`;
    const tokenData = await exchangeGoogleCode(code as string, redirectUri, creds.clientId, creds.clientSecret);

    // Calculate expiration time
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

    await upsertIntegration({
      id: nanoid(),
      userId,
      provider: "google",
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt,
      scope: tokenData.scope,
      metadata: null,
    });

    res.redirect("/settings?success=google");
  } catch (error) {
    console.error("Google OAuth error:", error);
    res.redirect(`/settings?error=google&message=${encodeURIComponent((error as Error).message)}`);
  }
});

// WHOOP OAuth initiation
router.get("/oauth/whoop", async (req, res) => {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user?.id) {
      return res.redirect("/settings?error=whoop&message=not_authenticated");
    }

    const creds = await getOAuthCredential(user.id, "whoop");
    if (!creds?.clientId) {
      return res.redirect("/settings?error=whoop&message=credentials_not_configured");
    }

    const state = crypto.randomBytes(32).toString("hex");
    oauthStates.set(state, { userId: user.id, timestamp: Date.now() });

    const redirectUri = `${getBaseUrl(req)}/api/oauth/whoop/callback`;
    const scope = [
      "read:profile",
      "read:recovery",
      "read:sleep",
      "read:cycles",
      "offline",
    ].join(" ");

    const authUrl = `https://api.prod.whoop.com/oauth/oauth2/auth?${new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      state,
    })}`;

    res.redirect(authUrl);
  } catch (error) {
    console.error("WHOOP OAuth initiation error:", error);
    res.redirect("/settings?error=whoop&message=initiation_failed");
  }
});

// WHOOP OAuth callback
router.get("/oauth/whoop/callback", async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    return res.redirect(`/settings?error=whoop&message=${error}`);
  }

  if (!code || !state) {
    return res.redirect("/settings?error=whoop&message=no_code_or_state");
  }

  try {
    const stateData = oauthStates.get(state as string);
    if (!stateData) {
      return res.redirect("/settings?error=whoop&message=invalid_state");
    }
    oauthStates.delete(state as string);

    const userId = stateData.userId;
    const creds = await getOAuthCredential(userId, "whoop");
    if (!creds?.clientId || !creds?.clientSecret) {
      return res.redirect("/settings?error=whoop&message=credentials_not_configured");
    }

    const redirectUri = `${getBaseUrl(req)}/api/oauth/whoop/callback`;
    const tokenData = await exchangeWhoopCode(
      code as string,
      redirectUri,
      creds.clientId,
      creds.clientSecret
    );
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

    await upsertIntegration({
      id: nanoid(),
      userId,
      provider: "whoop",
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt,
      scope: tokenData.scope,
      metadata: null,
    });

    res.redirect("/settings?success=whoop");
  } catch (err) {
    console.error("WHOOP OAuth error:", err);
    res.redirect(`/settings?error=whoop&message=${encodeURIComponent((err as Error).message)}`);
  }
});

// WHOOP webhook endpoint (initial implementation: acknowledge and log event metadata).
router.post("/webhooks/whoop", async (req, res) => {
  try {
    const payload = req.body ?? {};
    const eventType =
      typeof payload?.type === "string" ? payload.type : "unknown";
    const eventId =
      typeof payload?.id === "string" || typeof payload?.id === "number"
        ? String(payload.id)
        : "unknown";

    console.log(`[WHOOP Webhook] ${eventType} id=${eventId}`);
    return res.status(204).send();
  } catch (error) {
    console.error("[WHOOP Webhook] Error handling event:", error);
    return res.status(500).json({ error: "Webhook handling failed" });
  }
});

/**
 * Resolve the authenticated target user for a Samsung Health webhook
 * call. Returns either `{ userId }` on success or
 * `{ error, status }` on failure; the caller should short-circuit
 * with the error shape.
 */
// Main is single-user by design; this webhook is scoped to
// SAMSUNG_HEALTH_USER_ID. Do not generalize without rethinking auth.
function resolveSamsungWebhookUser(
  req: Request
): { userId: number } | { status: number; error: string } {
  const configuredSyncKey = process.env.SAMSUNG_HEALTH_SYNC_KEY?.trim();
  if (!configuredSyncKey) {
    return { status: 503, error: "SAMSUNG_HEALTH_SYNC_KEY is not configured on the server" };
  }

  const providedSyncKey = (req.get?.("x-sync-key") as string | undefined)?.trim() ?? "";
  if (!providedSyncKey || !safeTimingEqual(configuredSyncKey, providedSyncKey)) {
    return { status: 401, error: "Invalid sync key" };
  }

  const targetUserId = Number.parseInt(process.env.SAMSUNG_HEALTH_USER_ID ?? "1", 10);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    return { status: 500, error: "SAMSUNG_HEALTH_USER_ID must be a positive integer" };
  }

  return { userId: targetUserId };
}

/**
 * Persist a single Samsung Health payload: archive the raw payload,
 * then upsert the derived summary into the integrations row.
 *
 * `updateLiveSummary = false` is used by the batch endpoint for
 * historical days — we want to archive the raw data but not let a
 * week-old payload clobber today's integration summary.
 */
async function ingestSamsungPayload(
  targetUserId: number,
  rawBody: unknown,
  options: { updateLiveSummary: boolean },
): Promise<{ success: true; receivedAt: string; dateKey: string } | { error: string; status: number }> {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return { status: 400, error: "Invalid JSON body" };
  }

  const receivedAt = new Date().toISOString();
  const existing = await getIntegrationByProvider(targetUserId, "samsung-health");
  const manualScores = parseSamsungManualScores(existing?.metadata);
  let existingMetadata: Record<string, unknown> = {};
  if (existing?.metadata) {
    try {
      existingMetadata = asRecord(JSON.parse(existing.metadata));
    } catch {
      existingMetadata = {};
    }
  }
  const existingSummary = asRecord(existingMetadata.summary);

  const payloadRecord = asRecord(rawBody);
  const payloadSync = asRecord(payloadRecord.sync);
  const warnings = extractStringList(payloadSync.warnings);
  const warningsWithoutForeground = warnings.filter(
    (warning) => !warning.toLowerCase().includes("must be in foreground"),
  );
  payloadRecord.sync = {
    ...payloadSync,
    warnings: warningsWithoutForeground,
  };

  const degradedSync = isDegradedSamsungSync(payloadSync, warnings);
  const incomingDate = asString(payloadRecord.date);
  const existingDate = asString(existingSummary.date);
  const sameDateAsExisting = Boolean(incomingDate && existingDate && incomingDate === existingDate);

  // Consolidated step-preservation: if the new read is missing or
  // looks degraded (any "steps read failed" warning), fall back to
  // the previously stored value for the same day. This replaces the
  // two overlapping branches from the pre-rewrite handler.
  const anyStepReadWarning = warnings.some((warning) =>
    warning.toLowerCase().includes("steps read failed"),
  );
  const payloadActivity = asRecord(payloadRecord.activity);
  const incomingSteps = asNumber(payloadActivity.steps);
  const existingSteps = asNumber(existingSummary.steps);

  if (
    sameDateAsExisting &&
    existingSteps !== null &&
    existingSteps > 0 &&
    (incomingSteps === null ||
      (anyStepReadWarning && (incomingSteps <= 0 || incomingSteps < existingSteps)))
  ) {
    payloadRecord.activity = {
      ...payloadActivity,
      steps: existingSteps,
    };
    // If the only reason we fell back was a foreground-requirement
    // warning, scrub it from the payload too so the UI doesn't show
    // a stale error banner.
    const onlyForegroundWarning = warnings.every(
      (warning) =>
        !warning.toLowerCase().includes("steps read failed") ||
        warning.toLowerCase().includes("must be in foreground"),
    );
    if (onlyForegroundWarning) {
      payloadRecord.sync = {
        ...asRecord(payloadRecord.sync),
        warnings: warningsWithoutForeground.filter(
          (warning) => !warning.toLowerCase().includes("steps read failed"),
        ),
      };
    }
  }

  const rawDateKey =
    typeof payloadRecord.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payloadRecord.date)
      ? payloadRecord.date
      : receivedAt.slice(0, 10);

  await addSamsungSyncPayload({
    id: nanoid(),
    userId: targetUserId,
    dateKey: rawDateKey,
    capturedAt: new Date(receivedAt),
    payload: JSON.stringify(payloadRecord),
  });

  // Always compute the summary block so we can write the day's row to
  // dailyHealthMetrics regardless of whether this ingest is updating the
  // live integration summary. The Android Health screen reads from
  // dailyHealthMetrics, so without this the phone stays empty until the
  // nightly snapshot job runs (and historical backfill never updates
  // the table at all). The web reads from the integration metadata
  // directly, hence the live-summary gating below for that path only.
  //
  // Manual scores (sleepScore, energyScore) are stored as a single
  // global slot on the integration metadata and are inherently per-date
  // — they reflect the user's manual entry for the *current* live day.
  // Applying them to a historical backfill payload would stamp today's
  // 75/93 onto every past day, which is exactly the bug we hit on
  // 2026-04-25. So only fall back to manualScores when the incoming
  // payload's date matches the live summary's date (i.e. this is a
  // sync for "today"). Historical payloads pass null and the
  // dailyHealthMetrics row's manual-score columns get overwritten with
  // null too (see upsertSamsungDailyMetric — manual columns are not
  // null-preserved).
  const manualScoresForThisPayload = sameDateAsExisting ? manualScores : null;
  const metadata = buildSamsungMetadata(payloadRecord, receivedAt, manualScoresForThisPayload, {
    previousSummary: existingSummary,
    preservePreviousIfDegraded: degradedSync && sameDateAsExisting,
  });

  if (options.updateLiveSummary) {
    await upsertIntegration({
      id: nanoid(),
      userId: targetUserId,
      provider: "samsung-health",
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      scope: null,
      metadata,
    });
  }

  try {
    const parsedMetadata = JSON.parse(metadata) as {
      summary?: Record<string, unknown>;
    };
    const summary = parsedMetadata.summary ?? {};
    const sleepMinutes = asNumber(summary.sleepTotalMinutes);
    await upsertSamsungDailyMetric({
      userId: targetUserId,
      dateKey: rawDateKey,
      samsungSteps: asNumber(summary.steps),
      samsungSleepHours:
        sleepMinutes !== null ? Number((sleepMinutes / 60).toFixed(1)) : null,
      samsungSpo2AvgPercent: asNumber(summary.spo2AvgPercent),
      samsungSleepScore: asNumber(summary.sleepScore),
      samsungEnergyScore: asNumber(summary.energyScore),
    });
  } catch (error) {
    // Don't fail the webhook over the secondary write — the integration
    // metadata is the source of truth, dailyHealthMetrics is a
    // denormalized convenience for the Android client.
    console.error(
      "[Samsung Health Webhook] Failed to upsert dailyHealthMetrics:",
      error,
    );
  }

  return { success: true, receivedAt, dateKey: rawDateKey };
}

// Samsung Health webhook endpoint — single day
router.post("/webhooks/samsung-health", async (req, res) => {
  try {
    const auth = resolveSamsungWebhookUser(req);
    if ("error" in auth) {
      return res.status(auth.status).json({
        _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
        error: auth.error,
      });
    }

    const result = await ingestSamsungPayload(auth.userId, req.body, {
      updateLiveSummary: true,
    });
    if ("error" in result) {
      return res.status(result.status).json({
        _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
        error: result.error,
      });
    }
    return res.status(200).json({
      _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
      _checkpoint: "samsung-single-v1" as const,
      success: true,
      receivedAt: result.receivedAt,
      dateKey: result.dateKey,
    });
  } catch (error) {
    console.error("[Samsung Health Webhook] Error handling sync:", error);
    return res.status(500).json({
      _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
      error: "Failed to process Samsung Health payload",
    });
  }
});

// Samsung Health webhook endpoint — batch (historical backfill)
router.post("/webhooks/samsung-health/batch", async (req, res) => {
  try {
    const auth = resolveSamsungWebhookUser(req);
    if ("error" in auth) {
      return res.status(auth.status).json({
        _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
        error: auth.error,
      });
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({
        _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
        error: "Invalid JSON body",
      });
    }
    const payloads = (body as { payloads?: unknown }).payloads;
    if (!Array.isArray(payloads) || payloads.length === 0) {
      return res.status(400).json({
        _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
        error: "`payloads` must be a non-empty array",
      });
    }
    if (payloads.length > 31) {
      return res.status(400).json({
        _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
        error: "Batch too large (max 31 days)",
      });
    }

    // Sort chronologically (oldest → newest) for stable processing.
    const sorted = [...payloads].sort((a, b) => {
      const aDate = typeof a === "object" && a && "date" in (a as Record<string, unknown>)
        ? String((a as Record<string, unknown>).date ?? "")
        : "";
      const bDate = typeof b === "object" && b && "date" in (b as Record<string, unknown>)
        ? String((b as Record<string, unknown>).date ?? "")
        : "";
      return aDate.localeCompare(bDate);
    });

    // Only the payload whose date matches the live summary's "today"
    // should update the integration's live summary. Earlier code used
    // `isLast = (i === sorted.length - 1)` on the assumption that the
    // most recent payload in a batch is always today. That assumption
    // breaks for the historical worker: it explicitly excludes today
    // (today is owned by the periodic single-day sync), so the batch's
    // "last" is yesterday — and tagging yesterday as the live summary
    // overwrites today's data on the dashboard. (2026-04-26 bug.)
    //
    // Compute today's dateKey from the request server side. We use the
    // first payload's `timezone` if it carries one — Android sends
    // `ZoneId.systemDefault()` — otherwise fall back to UTC. If the
    // batch contains today, that one payload updates the live summary;
    // if it doesn't, the live summary is left alone for the periodic
    // single-day sync to manage.
    const firstPayloadTz = (() => {
      const first = sorted[0];
      if (first && typeof first === "object" && "timezone" in (first as Record<string, unknown>)) {
        const tz = (first as Record<string, unknown>).timezone;
        if (typeof tz === "string" && tz.length > 0) return tz;
      }
      return "UTC";
    })();
    let todayDateKey: string;
    try {
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: firstPayloadTz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      todayDateKey = fmt.format(new Date());
    } catch {
      todayDateKey = new Date().toISOString().slice(0, 10);
    }

    const accepted: string[] = [];
    const rejected: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < sorted.length; i++) {
      const payload = sorted[i];
      const payloadDate =
        typeof payload === "object" && payload && "date" in (payload as Record<string, unknown>)
          ? String((payload as Record<string, unknown>).date ?? "")
          : "";
      const isToday = payloadDate === todayDateKey;
      const result = await ingestSamsungPayload(auth.userId, payload, {
        updateLiveSummary: isToday,
      });
      if ("error" in result) {
        rejected.push({ index: i, error: result.error });
      } else {
        accepted.push(result.dateKey);
      }
    }

    return res.status(200).json({
      _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
      _checkpoint: "samsung-batch-v1" as const,
      success: rejected.length === 0,
      acceptedDateKeys: accepted,
      rejected,
    });
  } catch (error) {
    console.error("[Samsung Health Webhook Batch] Error handling backfill:", error);
    return res.status(500).json({
      _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
      error: "Failed to process Samsung Health batch",
    });
  }
});

/**
 * Samsung Health webhook debug endpoint.
 *
 * Authenticates via the same `x-sync-key` header as the ingest
 * routes and returns the raw state of the Samsung Health integration
 * for the configured target user: the live integration summary, the
 * most recent N raw payload rows, and the version markers.
 *
 * Mirrors the `debugScheduleBImportRaw` pattern from
 * `server/routers/solarRecDashboard.ts` so that "is my code actually
 * running?" can be answered by a single curl without needing to
 * reproduce a full sync from the Android app.
 */
router.get("/webhooks/samsung-health/debug", async (req, res) => {
  try {
    const auth = resolveSamsungWebhookUser(req);
    if ("error" in auth) {
      return res.status(auth.status).json({
        _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
        error: auth.error,
      });
    }

    const limitRaw = Number.parseInt(
      typeof req.query.limit === "string" ? req.query.limit : "10",
      10,
    );
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;

    const db = await getDb();
    if (!db) {
      return res.status(503).json({
        _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
        _checkpoint: "samsung-debug-v1" as const,
        error: "Database unavailable",
      });
    }

    const integration = await getIntegrationByProvider(auth.userId, "samsung-health");
    let integrationMetadata: Record<string, unknown> | null = null;
    if (integration?.metadata) {
      try {
        integrationMetadata = asRecord(JSON.parse(integration.metadata));
      } catch {
        integrationMetadata = null;
      }
    }
    const integrationSummary = integrationMetadata
      ? asRecord(integrationMetadata.summary)
      : null;

    const recentPayloads = await db
      .select({
        id: samsungSyncPayloads.id,
        dateKey: samsungSyncPayloads.dateKey,
        capturedAt: samsungSyncPayloads.capturedAt,
      })
      .from(samsungSyncPayloads)
      .where(eq(samsungSyncPayloads.userId, auth.userId))
      .orderBy(desc(samsungSyncPayloads.capturedAt))
      .limit(limit);

    // Surface the daily roll-up rows that the phone + CSV export read
    // from. samsungSyncPayloads above tells us what the webhook ingest
    // received; dailyHealthMetrics tells us whether `upsertSamsungDailyMetric`
    // actually wrote a row per dateKey. If the two diverge for the
    // same dates, the daily upsert is silently failing and historical
    // backfill won't surface in the dashboard.
    const dailyMetricsRows = await getDailyMetricsHistory(auth.userId, Math.min(limit * 5, 200));

    const latestPayload = await getLatestSamsungSyncPayload(auth.userId);
    let latestPayloadParsed: Record<string, unknown> | null = null;
    if (latestPayload?.payload) {
      try {
        latestPayloadParsed = asRecord(JSON.parse(latestPayload.payload));
      } catch {
        latestPayloadParsed = null;
      }
    }

    return res.status(200).json({
      _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
      _checkpoint: "samsung-debug-v1" as const,
      userId: auth.userId,
      integration: integration
        ? {
            hasMetadata: Boolean(integration.metadata),
            summary: integrationSummary,
            manualScores: parseSamsungManualScores(integration.metadata),
          }
        : null,
      latestPayload: latestPayload
        ? {
            id: latestPayload.id,
            dateKey: latestPayload.dateKey,
            capturedAt: latestPayload.capturedAt,
            sync: latestPayloadParsed ? asRecord(latestPayloadParsed.sync) : null,
            source: latestPayloadParsed ? asRecord(latestPayloadParsed.source) : null,
            summary: latestPayloadParsed
              ? {
                  date: asString(latestPayloadParsed.date),
                  steps: asNumber(asRecord(latestPayloadParsed.activity).steps),
                  sleepTotalMinutes: asNumber(
                    asRecord(latestPayloadParsed.sleep).totalSleepMinutes,
                  ),
                  recordTypesSucceeded: extractStringList(
                    asRecord(latestPayloadParsed.sync).recordTypesSucceeded,
                  ),
                  warnings: extractStringList(
                    asRecord(latestPayloadParsed.sync).warnings,
                  ),
                }
              : null,
          }
        : null,
      recentPayloads: recentPayloads.map((row) => ({
        id: row.id,
        dateKey: row.dateKey,
        capturedAt: row.capturedAt,
      })),
      totalRecentPayloads: recentPayloads.length,
      dailyMetrics: dailyMetricsRows.map((row) => ({
        dateKey: row.dateKey,
        samsungSteps: row.samsungSteps,
        samsungSleepHours: row.samsungSleepHours,
        samsungSpo2AvgPercent: row.samsungSpo2AvgPercent,
        samsungSleepScore: row.samsungSleepScore,
        samsungEnergyScore: row.samsungEnergyScore,
        updatedAt: row.updatedAt,
      })),
      totalDailyMetrics: dailyMetricsRows.length,
    });
  } catch (error) {
    console.error("[Samsung Health Webhook Debug] Error:", error);
    return res.status(500).json({
      _runnerVersion: SAMSUNG_HEALTH_WEBHOOK_VERSION,
      error: "Failed to load Samsung Health debug state",
    });
  }
});

export default router;
