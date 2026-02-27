# Coherence Samsung Health Companion

This Android app now includes Step 2 collection using Health Connect reads and pushes the normalized payload to your Coherence webhook.

## What this includes

- Android app skeleton (Kotlin, API 29+)
- Health Connect permission flow in app UI
- WorkManager sync pipeline (manual + periodic)
- Webhook uploader (`x-sync-key` header)
- High-coverage normalized payload model for health data
- Live read mapping for key record types (steps, sleep, heart, SpO2, blood pressure, glucose, nutrition, hydration, body metrics)

## Folder layout

- `app/src/main/java/com/coherence/samsunghealth/model/SamsungHealthPayload.kt`: normalized payload contract
- `app/src/main/java/com/coherence/samsunghealth/sdk/SamsungHealthDataSdkRepository.kt`: data read + mapping pipeline
- `app/src/main/java/com/coherence/samsunghealth/sync/SamsungHealthSyncWorker.kt`: scheduler + sync execution
- `app/src/main/java/com/coherence/samsunghealth/sync/WebhookClient.kt`: POST client
- `app/src/main/java/com/coherence/samsunghealth/mapping/SupportedDataPoints.kt`: targeted datapoint inventory

## Configure

1. Open this folder in Android Studio: `android/samsung-health-companion`.
2. In `app/build.gradle.kts`, set:
   - `WEBHOOK_URL` to your deployed endpoint (`https://app.coherence-rmg.com/api/webhooks/samsung-health`).
   - `SYNC_KEY` to your server sync key.
3. Build and run on Android 10+.

## Current behavior

1. Open app and tap `Open Health Connect`.
2. Tap `Grant Health Permissions`.
3. Tap `Sync Now` to run a foreground sync and push live payload once.
4. Tap `Enable 15-min Auto Sync` for periodic refresh.

Notes:
- The app now syncs with partial permissions too. Grant core metrics first (steps, sleep, heart rate, exercise, calories, distance), then add optional metrics later.
- `floors` and `vo2` are treated as best-effort because some Health Connect versions/devices do not expose those permission toggles.
- Some body composition types (such as body fat) may be foreground-only on certain devices; periodic background sync may skip those records.

## Notes

- Keep the payload schema stable; add new fields as additive changes only.
- If you later move to Samsung Health Data SDK partner APIs, keep this payload contract and replace data-read internals only.
