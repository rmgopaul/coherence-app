# Health Connect / Samsung Health — Triage Findings

> Task 1.1a per `docs/execution-plan.md`. Findings only — no fix attempted.
> Author: Claude (investigation). Date: 2026-04-23.

## TL;DR

- **CORS blockage found.** The server's CORS allowed-headers list does not include `x-sync-key` (the auth header the mobile app sends on every webhook POST). Pre-flights for that header are rejected, so every request is blocked *before* the webhook handler runs.
- **Rate limit is not the culprit on the server side.** The general `/api` limiter (100 req/min per IP) and auth limiter (20 req/min) don't apply to `/api/webhooks/*` specifically; no per-endpoint limiter is configured. The webhook handler itself has no rate limiting.
- **Mobile cooldown exists but is masked.** The Android app implements a 24-hour cooldown on Health Connect read quota exhaustion, but if CORS is blocking the webhook, the app never gets a response — so it can't detect a rate-limit condition and the cooldown mechanism never engages.
- **No server-side retry amplification.** The webhook handler does not retry on error. Archives the payload and returns 200 immediately. No feedback loop exists on the server side.
- **`samsungSyncPayloads` is the single write path.** Every ingest (single or batch) writes one row per `dateKey`. If this table has been empty for the target user for weeks, the sync outage is confirmed.

## Data flow (device → server → DB)

```
Android app (remotes/origin/claude/coherence-mobile-app-MGy5v)
├─ HealthConnectPeriodicSyncWorker (60-minute cadence)
│  └─ POST /api/webhooks/samsung-health
│     ├─ Header: x-sync-key: <SAMSUNG_HEALTH_SYNC_KEY>
│     └─ Body: SamsungHealthPayload (JSON, ~5 KB)
│
Browser/OkHttp layer
├─ CORS pre-flight: is "x-sync-key" in server's allowedHeaders?
│  └─ FAILS HERE — header not in allowedHeaders
│
Server (would run if CORS passed)
├─ CORS middleware
├─ pinGate.isAllowedWithoutPin("/api/webhooks/samsung-health") → true
├─ resolveSamsungWebhookUser(req) validates x-sync-key
├─ ingestSamsungPayload(targetUserId, body, { updateLiveSummary: true })
│  ├─ INSERT INTO samsungSyncPayloads (raw JSON archive)
│  └─ UPSERT integration metadata (summary feed for dailyHealthMetrics)
└─ Response 200 { success: true, dateKey, receivedAt }

dailyHealthMetrics
└─ Hydrated by daily snapshot service or UI queries (not the webhook)
```

## Surface inventory

| Component | Path | What it does |
|---|---|---|
| Mobile webhook client | `remotes/origin/claude/coherence-mobile-app-MGy5v : android/healthconnect-companion/app/.../sync/WebhookClient.kt` | POST to single-day + batch endpoints; classifies retryable vs permanent failures. Sets `x-sync-key`. |
| Mobile periodic worker | `same branch : sync/HealthConnectPeriodicSyncWorker.kt` | 60-min cadence; collects daily payload; checks cooldown before posting. |
| Mobile cooldown | `same branch : sdk/HealthConnectCooldown.kt` | On rate-limit error from Health Connect API, engages 24h cooldown; persisted via SharedPreferences. |
| Server webhook handler | `server/oauth-routes.ts:580-650` | Validates `x-sync-key`; archives payload; upserts integration metadata. |
| Server webhook batch | `server/oauth-routes.ts:652-725` | Same auth + validation; loops through array; one row per `dateKey`. |
| **CORS middleware** | `server/_core/security.ts:48-61` | `allowedHeaders: ["Content-Type", "Authorization", "x-solar-signature", "x-solar-timestamp", "x-solar-nonce"]` — **does not include `x-sync-key`**. |
| pinGate allow-list | `server/_core/pinGate.ts:45-50` | Explicitly allows `/api/webhooks/samsung-health*` without PIN. Not a blocker. |
| Rate limiters | `server/_core/security.ts:62-82` | `/api` = 100 req/min; `/api/trpc/solarReadings.submit` = 20 req/min; `/api/oauth` = 20 req/min. None target the webhook specifically. |
| DB archive | `drizzle/schemas/core.ts:412-429` | `samsungSyncPayloads`: one row per POST, unique `(userId, dateKey)`. Indexed on `(userId, capturedAt)`. |
| DB metrics | `drizzle/schemas/core.ts:30-56` | `dailyHealthMetrics`: one row per user per day; Samsung columns for steps, sleep, SpO2, energy score. |

## Findings

### F1 — CORS `x-sync-key` header not in `allowedHeaders`
**Confidence:** **HIGH**
**Evidence:** `server/_core/security.ts:54-59` — allowedHeaders lists only `Content-Type`, `Authorization`, and three `x-solar-*` headers. `x-sync-key` is absent.
**Implication:** OkHttp (Android) enforces CORS pre-flight for unknown headers on cross-origin POSTs. The pre-flight fails, the POST never runs, the webhook handler never sees the request. The mobile app observes a network error, not a 429 or 401. This is a silent server-side blockage that won't appear in Express access logs.

### F2 — No rate limiting on webhook endpoints
**Confidence:** **HIGH**
**Evidence:** `server/_core/security.ts:62-82` — three limiters cover `/api` (100/min), `/api/trpc/solarReadings.submit` (20/min), `/api/oauth` (20/min). Webhook is under `/api`, so 100/min applies — far above the 1/min sync cadence.
**Implication:** Server-side rate limiting is not the source of a multi-week outage. If the reported symptom is rate-limit-like, the culprit lives elsewhere (mobile-side Health Connect API quota, or the CORS blockage misinterpreted as rate-limiting by users).

### F3 — Mobile app implements 24h cooldown on Health Connect quota exhaustion
**Confidence:** **HIGH**
**Evidence:** `HealthConnectCooldown.kt:22-33` (cooldown class, `DEFAULT_COOLDOWN_HOURS = 24`); `HealthConnectReader.kt:131-139` (`markRateLimited(message)` on quota hit); `HealthConnectPeriodicSyncWorker.kt:55-61` (worker returns early if cooldown active).
**Implication:** The 24h cooldown is a circuit breaker for the *Health Connect read API*, not for the webhook. It prevents the app from re-reading from Health Connect when Google's quota is hit. But it does not engage for CORS/network errors on the webhook POST — those are classified as transient `IOException` and retried every 10 minutes via WorkManager.

### F4 — No webhook-level retry on the server side
**Confidence:** **HIGH**
**Evidence:** `server/oauth-routes.ts:580-610` — on success returns 200; on error returns 4xx/5xx and stops. No retry, buffer, or async queue.
**Implication:** No feedback loop exists on the server that would amplify rate-limit conditions. If the mobile app is stuck in a retry loop, the amplification is on the mobile side (F6), not the server.

### F5 — `samsungSyncPayloads` is the sole write path; `dailyHealthMetrics` hydrates separately
**Confidence:** **HIGH**
**Evidence:** `server/oauth-routes.ts:554-560` (every webhook calls `addSamsungSyncPayload`); `drizzle/schemas/core.ts:412-429` (unique `(userId, dateKey)` archive).
**Implication:** Confirming the outage = query `samsungSyncPayloads` for the target user over the last 30 days. A gap = the outage window. `dailyHealthMetrics` is populated on-demand from the integration metadata snapshot, not directly from the archive row.

### F6 — Mobile app does not retry gracefully on CORS failures
**Confidence:** **MEDIUM**
**Evidence:** `WebhookClient.kt:92-118` — CORS failure manifests as `IOException` in OkHttp's `onFailure`. Classified as `WebhookResult.Retryable` at line 105; worker calls `Result.retry()` at `HealthConnectPeriodicSyncWorker.kt:74`; WorkManager retries with linear backoff every 10 minutes (`AutoSyncScheduler.kt:153`).
**Implication:** CORS errors don't carry a response body with rate-limit semantics, so the cooldown mechanism (F3) never engages. The app enters an indefinite retry loop with no observable signal to the user beyond "still syncing." If F1 is correct, this explains why the outage persists — fixing CORS unblocks the retry loop to finally succeed.

## Root-cause hypotheses (ranked)

1. **CORS header block (primary)** — confidence: **HIGH**. `x-sync-key` is not in `allowedHeaders`. Every POST fails pre-flight; mobile app retries forever via `IOException` path; cooldown never engages because the response never carries a rate-limit body. Explains the "sync fails again almost immediately" symptom (every retry = same CORS failure). Explains the multi-week outage (no natural recovery). No log entries on the server side because requests never reach Express — which also explains why this wasn't caught earlier.
2. **Health Connect API quota exhaustion on the device (secondary)** — confidence: **MEDIUM**. If the device is reading 22 record types × 24 syncs/day = 528 reads/day, a single-digit-quota limit would lock reads. The 24h cooldown would trigger correctly, producing the "locks for ~24 hours, fails again almost immediately" pattern. Requires checking mobile logcat for `rate-limited; cooldown engaged` messages. If F1 alone explains the symptom, this is moot.
3. **Server-side rate limiting (low)** — confidence: **LOW**. The general `/api` limiter at 100/min is far above the 1/min sync cadence. Only plausible if a bug caused the worker to retry >100 times per minute, which the current code doesn't do.

## Open questions / data I couldn't access

- **Mobile app logs (logcat) for the last 30 days** — what status/error is `WebhookClient` observing? Network error (`IOException`), or HTTP 403/429? What does `onFailure`'s `e.message` say?
- **Server access logs** — any requests to `/api/webhooks/samsung-health*` in the last 7 days? (A total absence confirms F1; any 429s would argue for F3/hypothesis 3.)
- **`samsungSyncPayloads` row count by date** for the target `userId` — when did the last successful payload arrive?
- **Health Connect quota state on the Android device** — any quota-reset messages in the system health app or logcat?
- **Deployment status of the mobile branch** — is `claude/coherence-mobile-app-MGy5v` the deployed version, or is a newer build in flight?

## Proposed fix direction (NOT yet written)

### Option A — Add `x-sync-key` to CORS `allowedHeaders` (primary, minimal, server-only)
Modify `server/_core/security.ts:54-59` to include `x-sync-key` in `allowedHeaders`. 1-line change. Low risk, backward-compatible, immediate.
If F1 is correct, this unblocks the retry loop and sync resumes within the next worker tick (≤10 minutes). Observation window: check `samsungSyncPayloads` row count over the 24h after deploy.

### Option B — Investigate Health Connect quota if A doesn't resolve (mobile diagnostic)
Check logcat on the Android device for `markRateLimited` / `cooldown engaged` entries. If quota is the bottleneck, lower `PERIODIC_INTERVAL_MINUTES` cadence from 60→90 or 120 in `AutoSyncScheduler.kt`, or batch reads more aggressively in `HealthConnectPayloadMapper`. This is outside the productivity-hub repo (mobile-app change).

### Option C — Defensive: add rate-limit response headers to the webhook (low-priority)
Even after fixing CORS, return `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on webhook responses so the mobile app can surface quota state to the user instead of retrying blindly. Not needed for the primary fix; useful observability.

## What happens next

Task 1.1b (fix PR) follows, contingent on user acknowledgement of this report. Recommended sequence:
1. Ack findings.
2. Ship Option A (CORS header) as the minimal first fix.
3. Observe `samsungSyncPayloads` for 24–48 hours.
4. If sync resumes → close out Task 1.1. If not → pivot to Option B (mobile diagnostic).
