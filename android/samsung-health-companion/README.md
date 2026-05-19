# samsung-health-companion

Minimal Android companion that reads the two Samsung-proprietary
scores via the **Samsung Health Data SDK** and POSTs them to the
existing productivity-hub webhook (`POST /api/webhooks/samsung-health`).

## Scope

This module does ONE thing: request Samsung Health Data permissions
for **Sleep** + **Energy Score**, periodically read them, and forward
them to the server. No widgets, no Glance, no OAuth, no navigation —
just a single status screen (permission button + last-sync text).

For the full-featured app (Health Connect, widgets, OAuth, dashboard)
see the sibling `android/healthconnect-companion/` module. This
module deliberately mirrors that module's build scaffolding and
`WebhookClient` / `SyncConfig` / `SamsungHealthPayload` patterns so
the existing server endpoint parses its payload unchanged.

## SDK

Reads via the local artifact
`app/libs/samsung-health-data-api-1.1.0.aar`
(`com.samsung.android.sdk.health.data`). The SDK talks to the bound
Samsung Health phone service — it is **not** Health Connect and uses
no `android.permission.health.*` permissions. Permissions are
granted through `HealthDataStore.requestPermissions(Set<Permission>,
Activity)`.

- Sleep Score — `DataType.SleepType.SLEEP_SCORE` (`Field<Integer>`,
  0–100), read through `DataTypes.SLEEP` (a
  `ReadDataRequest.DualTimeBuilder`, `LocalTimeFilter`).
- Energy Score — `DataType.EnergyScoreType.ENERGY_SCORE`
  (`Field<Float>`), read through `DataTypes.ENERGY_SCORE` (a
  `ReadDataRequest.LocalDateBuilder`, `LocalDateFilter`). Rounded to
  Int before sending (the server's `samsungEnergyScore` column is a
  rounded int).

## Build

```bash
cp local.properties.example local.properties   # set sdk.dir + SAMSUNG_HEALTH_*
cd android/samsung-health-companion
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ./gradlew :app:assembleDebug
```

`local.properties` uses the SAME `SAMSUNG_HEALTH_SYNC_KEY` /
`SAMSUNG_HEALTH_WEBHOOK_URL` keys as the healthconnect-companion
module, so one file configures both.

## Server-side follow-up (NOT done in this module's PR)

`server/oauth-routes.ts` `buildSamsungMetadata()` currently derives
`summary.sleepScore` / `summary.energyScore` ONLY from the
integration's manual-score slot, never from the inbound payload.
Until the server reads `payload.sleep.sleepScore` and
`payload.cardio.energyScore`, the SDK-read values are stored in
`samsungSyncPayloads` but do not flow into the
`dailyHealthMetrics.samsung{Sleep,Energy}Score` columns. See the PR
description for the exact change.
