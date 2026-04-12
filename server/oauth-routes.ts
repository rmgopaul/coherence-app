import { Router } from "express";
import { nanoid } from "nanoid";
import { upsertIntegration, getOAuthCredential, getIntegrationByProvider, addSamsungSyncPayload } from "./db";
import { exchangeGoogleCode } from "./services/integrations/google";
import { exchangeWhoopCode } from "./services/integrations/whoop";
import { sdk } from "./_core/sdk";
import { ENV } from "./_core/env";
import crypto from "crypto";

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
function getBaseUrl(req: any): string {
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
    sleepScore: manualScores?.sleepScore ?? asNumber(sleep.sleepScore),
    energyScore: manualScores?.energyScore ?? asNumber(cardio.recoveryScore),
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

// Samsung Health webhook endpoint
router.post("/webhooks/samsung-health", async (req, res) => {
  try {
    const configuredSyncKey = process.env.SAMSUNG_HEALTH_SYNC_KEY?.trim();
    if (!configuredSyncKey) {
      return res.status(503).json({ error: "SAMSUNG_HEALTH_SYNC_KEY is not configured on the server" });
    }

    const providedSyncKey = req.get("x-sync-key")?.trim() ?? "";
    if (!providedSyncKey || !safeTimingEqual(configuredSyncKey, providedSyncKey)) {
      return res.status(401).json({ error: "Invalid sync key" });
    }

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const targetUserId = Number.parseInt(process.env.SAMSUNG_HEALTH_USER_ID ?? "1", 10);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
      return res.status(500).json({ error: "SAMSUNG_HEALTH_USER_ID must be a positive integer" });
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

    const payloadRecord = asRecord(req.body);
    const payloadActivity = asRecord(payloadRecord.activity);
    const payloadSync = asRecord(payloadRecord.sync);
    const warnings = extractStringList(payloadSync.warnings);
    const warningsWithoutForeground = warnings.filter(
      (warning) => !warning.toLowerCase().includes("must be in foreground")
    );
    payloadRecord.sync = {
      ...payloadSync,
      warnings: warningsWithoutForeground,
    };
    const degradedSync = isDegradedSamsungSync(payloadSync, warnings);
    const incomingDate = asString(payloadRecord.date);
    const existingDate = asString(existingSummary.date);
    const sameDateAsExisting = Boolean(incomingDate && existingDate && incomingDate === existingDate);
    const foregroundStepWarning = warnings.some(
      (warning) =>
        warning.toLowerCase().includes("steps read failed") &&
        warning.toLowerCase().includes("must be in foreground")
    );
    const anyStepReadWarning = warnings.some((warning) =>
      warning.toLowerCase().includes("steps read failed")
    );
    const incomingSteps = asNumber(payloadActivity.steps);
    const existingSteps = asNumber(existingSummary.steps);

    // Preserve existing steps only when the incoming reading appears degraded.
    // Do not block legitimate lower values (for example, after a test payload or source correction).
    if (sameDateAsExisting && existingSteps !== null && existingSteps > 0) {
      const shouldKeepExistingSteps =
        incomingSteps === null ||
        (anyStepReadWarning && (incomingSteps <= 0 || incomingSteps < existingSteps));

      if (shouldKeepExistingSteps) {
        payloadRecord.activity = {
          ...asRecord(payloadRecord.activity),
          steps: existingSteps,
        };
      }
    }

    if (
      foregroundStepWarning &&
      existingSteps !== null &&
      existingSteps > 0 &&
      (incomingSteps === null || incomingSteps <= 0)
    ) {
      payloadRecord.activity = {
        ...asRecord(payloadRecord.activity),
        steps: existingSteps,
      };
      payloadRecord.sync = {
        ...asRecord(payloadRecord.sync),
        warnings: warningsWithoutForeground.filter(
          (warning) => !warning.toLowerCase().includes("steps read failed")
        ),
      };
    }

    const metadata = buildSamsungMetadata(payloadRecord, receivedAt, manualScores, {
      previousSummary: existingSummary,
      preservePreviousIfDegraded: degradedSync && sameDateAsExisting,
    });
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

    return res.status(200).json({ success: true, receivedAt });
  } catch (error) {
    console.error("[Samsung Health Webhook] Error handling sync:", error);
    return res.status(500).json({ error: "Failed to process Samsung Health payload" });
  }
});

export default router;
