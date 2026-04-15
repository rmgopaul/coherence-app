/**
 * Monitoring batch orchestration service.
 *
 * Runs API calls for all configured providers/sites and records results
 * in the monitoringApiRuns table. Designed to be called from the tRPC
 * monitoring.runAll mutation or from a scheduled cron job.
 */
import { nanoid } from "nanoid";
import * as db from "../db";
import { mapWithConcurrency } from "../services/core/concurrency";
import {
  pushMonitoringRunsToConvertedReads,
  type MonitoringRunRow,
} from "./convertedReadsBridge";
import { resolveSolarRecOwnerUserId } from "../_core/solarRecAuth";

// ---------------------------------------------------------------------------
// Provider registry — maps provider key to the service function that
// lists sites and fetches production snapshots.
// ---------------------------------------------------------------------------

type SiteInfo = { siteId: string; siteName: string };
type SnapshotResult = {
  siteId: string;
  siteName: string | null;
  status: "Found" | "Not Found" | "Error";
  lifetimeKwh: number | null;
  errorMessage?: string;
};

type ProviderAdapter = {
  listSites: (credential: { accessToken?: string | null; metadata?: string | null }) => Promise<SiteInfo[]>;
  getSnapshots: (
    credential: { accessToken?: string | null; metadata?: string | null },
    siteIds: string[],
    anchorDate: string
  ) => Promise<SnapshotResult[]>;
};

// Lazy-loaded provider adapters. Each adapter wraps the existing service
// functions in server/services/*.ts with a consistent interface.
const providerAdapters: Record<string, () => Promise<ProviderAdapter>> = {
  solaredge: () => import("./adapters/solaredge.adapter").then((m) => m.default),
  "enphase-v4": () => import("./adapters/enphaseV4.adapter").then((m) => m.default),
  fronius: () => import("./adapters/fronius.adapter").then((m) => m.default),
  generac: () => import("./adapters/generac.adapter").then((m) => m.default),
  hoymiles: () => import("./adapters/hoymiles.adapter").then((m) => m.default),
  goodwe: () => import("./adapters/goodwe.adapter").then((m) => m.default),
  solis: () => import("./adapters/solis.adapter").then((m) => m.default),
  locus: () => import("./adapters/locus.adapter").then((m) => m.default),
  apsystems: () => import("./adapters/apsystems.adapter").then((m) => m.default),
  solarlog: () => import("./adapters/solarlog.adapter").then((m) => m.default),
  growatt: () => import("./adapters/growatt.adapter").then((m) => m.default),
  egauge: () => import("./adapters/egauge.adapter").then((m) => m.default),
  "egauge-monitoring": () => import("./adapters/egauge.adapter").then((m) => m.default),
  "tesla-powerhub": () => import("./adapters/teslaPowerhub.adapter").then((m) => m.default),
  teslapowerhub: () => import("./adapters/teslaPowerhub.adapter").then((m) => m.default),
  ennexos: () => import("./adapters/ennexos.adapter").then((m) => m.default),
  "enphase-v2": () => import("./adapters/enphaseV2.adapter").then((m) => m.default),
  enphasev2: () => import("./adapters/enphaseV2.adapter").then((m) => m.default),
  "tesla-solar": () => import("./adapters/teslaSolar.adapter").then((m) => m.default),
  teslasolar: () => import("./adapters/teslaSolar.adapter").then((m) => m.default),
  ekm: () => import("./adapters/ekm.adapter").then((m) => m.default),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Max time (ms) to wait for a single site's getSnapshots call before recording a timeout error. */
const PER_SITE_TIMEOUT_MS = 30_000;

/** Extract a human-readable label from a credential's metadata (username, account, apiKey prefix). */
function extractCredentialLabel(
  cred: { connectionName?: string | null; metadata?: string | null; accessToken?: string | null } | undefined
): string | null {
  if (!cred) return null;
  if (cred.connectionName) return cred.connectionName;
  if (!cred.metadata) return cred.accessToken ? `...${cred.accessToken.slice(-6)}` : null;
  try {
    const meta = JSON.parse(cred.metadata);
    return meta.username ?? meta.account ?? meta.connectionName
      ?? (meta.apiKey ? `Key ...${meta.apiKey.slice(-6)}` : null);
  } catch {
    return null;
  }
}

/** Race a promise against a timeout. Rejects with a clear message on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ---------------------------------------------------------------------------
// Execute a single provider run
// ---------------------------------------------------------------------------

type SiteProgressCallback = (delta: {
  success: number;
  error: number;
  noData: number;
  run?: MonitoringRunRow;
}) => void;

export async function executeProviderRun(
  provider: string,
  dateKey: string,
  triggeredBy: number | null,
  options?: {
    credentialIds?: string[];
    onSiteProgress?: SiteProgressCallback;
  }
): Promise<{ success: number; error: number; noData: number }> {
  const selectedCredentialSet =
    options?.credentialIds && options.credentialIds.length > 0
      ? new Set(options.credentialIds)
      : null;

  let credentials = await db.getSolarRecTeamCredentialsByProvider(provider);
  if (selectedCredentialSet) {
    credentials = credentials.filter((credential) => selectedCredentialSet.has(credential.id));
  }

  if (credentials.length === 0) {
    console.log(`[Monitoring] No credentials for provider ${provider}, skipping`);
    return { success: 0, error: 0, noData: 0 };
  }

  const adapterLoader = providerAdapters[provider];
  if (!adapterLoader) {
    console.warn(`[Monitoring] No adapter for provider ${provider}`);
    try {
      await db.upsertMonitoringApiRun({
        id: nanoid(),
        provider,
        connectionId: credentials[0]?.id ?? null,
        siteId: `provider:${provider}`,
        siteName: provider,
        dateKey,
        status: "error",
        readingsCount: 0,
        lifetimeKwh: null,
        errorMessage: `No monitoring adapter registered for provider "${provider}". Contact support or check configuration.`,
        durationMs: null,
        triggeredBy,
        triggeredAt: new Date(),
      });
    } catch (persistError) {
      console.error(`[Monitoring] Failed to persist missing-adapter error for ${provider}:`, persistError);
    }
    return { success: 0, error: 1, noData: 0 };
  }

  let adapter: ProviderAdapter;
  try {
    adapter = await adapterLoader();
  } catch (err) {
    console.error(`[Monitoring] Failed to load adapter for ${provider}:`, err);
    return { success: 0, error: 0, noData: 0 };
  }

  let success = 0;
  let error = 0;
  let noData = 0;

  for (const cred of credentials) {
    try {
      const sites = await adapter.listSites(cred);
      if (sites.length === 0) continue;

      const snapshots = await mapWithConcurrency(sites, 4, async (site) => {
        const start = Date.now();
        try {
          // Wrap each site call with a timeout to prevent one slow API from blocking the batch
          const results = await withTimeout(
            adapter.getSnapshots(cred, [site.siteId], dateKey),
            PER_SITE_TIMEOUT_MS,
            `${provider}/${site.siteId}`
          );
          const result = results[0];
          const durationMs = Date.now() - start;

          let row;
          if (!result || result.status === "Not Found") {
            noData++;
            row = {
              provider,
              connectionId: cred.id,
              siteId: site.siteId,
              siteName: site.siteName,
              dateKey,
              status: "no_data" as const,
              readingsCount: 0,
              lifetimeKwh: null,
              durationMs,
              triggeredBy,
              triggeredAt: new Date(),
            };
          } else if (result.status === "Error") {
            error++;
            row = {
              provider,
              connectionId: cred.id,
              siteId: site.siteId,
              siteName: result.siteName ?? site.siteName,
              dateKey,
              status: "error" as const,
              readingsCount: 0,
              lifetimeKwh: null,
              errorMessage: result.errorMessage ?? "Unknown error",
              durationMs,
              triggeredBy,
              triggeredAt: new Date(),
            };
          } else {
            success++;
            row = {
              provider,
              connectionId: cred.id,
              siteId: site.siteId,
              siteName: result.siteName ?? site.siteName,
              dateKey,
              status: "success" as const,
              readingsCount: result.lifetimeKwh != null ? 1 : 0,
              lifetimeKwh: result.lifetimeKwh,
              durationMs,
              triggeredBy,
              triggeredAt: new Date(),
            };
          }

          // Persist immediately and notify batch of incremental progress
          await db.upsertMonitoringApiRun({ id: nanoid(), ...row });
          options?.onSiteProgress?.({
            success: row.status === "success" ? 1 : 0,
            error: row.status === "error" ? 1 : 0,
            noData: row.status === "no_data" ? 1 : 0,
            run: {
              provider,
              siteId: row.siteId,
              siteName: row.siteName ?? null,
              lifetimeKwh: row.lifetimeKwh ?? null,
              dateKey,
              status: row.status,
            },
          });
          return row;
        } catch (err) {
          error++;
          const row = {
            provider,
            connectionId: cred.id,
            siteId: site.siteId,
            siteName: site.siteName,
            dateKey,
            status: "error" as const,
            readingsCount: 0,
            lifetimeKwh: null,
            errorMessage: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
            triggeredBy,
            triggeredAt: new Date(),
          };
          await db.upsertMonitoringApiRun({ id: nanoid(), ...row });
          options?.onSiteProgress?.({ success: 0, error: 1, noData: 0 });
          return row;
        }
      });
      // Results already persisted per-site above
    } catch (err) {
      console.error(`[Monitoring] Provider ${provider} credential ${cred.id} failed:`, err);
      const message = err instanceof Error ? err.message : String(err);
      const credentialLabel =
        cred.connectionName ?? extractCredentialLabel(cred) ?? `Credential ${cred.id.slice(-6)}`;
      try {
        await db.upsertMonitoringApiRun({
          id: nanoid(),
          provider,
          connectionId: cred.id,
          siteId: `credential:${cred.id}`,
          siteName: credentialLabel,
          dateKey,
          status: "error",
          readingsCount: 0,
          lifetimeKwh: null,
          errorMessage: message,
          durationMs: null,
          triggeredBy,
          triggeredAt: new Date(),
        });
      } catch (persistError) {
        console.error(
          `[Monitoring] Failed to persist credential-level error row for ${provider}:${cred.id}:`,
          persistError
        );
      }
      error++;
    }
  }

  return { success, error, noData };
}

// ---------------------------------------------------------------------------
// Execute full batch across all providers
// ---------------------------------------------------------------------------

export async function executeMonitoringBatch(
  batchId: string,
  dateKey: string,
  triggeredBy: number | null,
  selectedProviders?: string[],
  selectedCredentialIds?: string[]
): Promise<void> {
  let totalSuccess = 0;
  let totalError = 0;
  let totalNoData = 0;
  let totalSites = 0;

  try {
    const allCredentials = await db.listSolarRecTeamCredentials();
    const selectedCredentialSet =
      selectedCredentialIds && selectedCredentialIds.length > 0
        ? new Set(
            selectedCredentialIds
              .map((credentialId) => credentialId.trim())
              .filter((credentialId) => credentialId.length > 0)
          )
        : null;
    const scopedCredentials = selectedCredentialSet
      ? allCredentials.filter((credential) => selectedCredentialSet.has(credential.id))
      : allCredentials;

    const allProviders = Array.from(new Set(scopedCredentials.map((c) => c.provider)));
    const selectedSet =
      selectedProviders && selectedProviders.length > 0
        ? new Set(
            selectedProviders
              .map((provider) => provider.trim().toLowerCase())
              .filter((provider) => provider.length > 0)
          )
        : null;
    const providers = selectedSet
      ? allProviders.filter((provider) => selectedSet.has(provider.toLowerCase()))
      : allProviders;

    await db.updateMonitoringBatchRun(batchId, {
      providersTotal: providers.length,
      providersCompleted: 0,
    });

    // Resolve the owner userId for pushing converted reads
    let ownerUserId: number | null = null;
    try {
      ownerUserId = await resolveSolarRecOwnerUserId();
      console.log(`[MonitoringBatch] Resolved owner userId: ${ownerUserId}`);
    } catch (err) {
      console.error(
        "[MonitoringBatch] Could not resolve owner userId — converted reads push will be skipped:",
        err instanceof Error ? err.message : err
      );
    }

    // Collect all completed runs across the batch for converted reads push
    const allCompletedRuns: MonitoringRunRow[] = [];

    let providersCompleted = 0;
    for (const provider of providers) {
      const providerCredentials = scopedCredentials.filter((credential) => credential.provider === provider);
      if (providerCredentials.length === 0) {
        providersCompleted++;
        continue;
      }

      const cred = providerCredentials[0];
      const credName = cred?.connectionName ?? extractCredentialLabel(cred);

      await db.updateMonitoringBatchRun(batchId, {
        currentProvider: provider,
        currentCredentialName: credName,
        totalSites,
        successCount: totalSuccess,
        errorCount: totalError,
        noDataCount: totalNoData,
      });

      const { success, error, noData } = await executeProviderRun(
        provider,
        dateKey,
        triggeredBy,
        {
          credentialIds: providerCredentials.map((credential) => credential.id),
          // Incremental progress: update batch status after each site completes
          onSiteProgress: (delta) => {
            totalSuccess += delta.success;
            totalError += delta.error;
            totalNoData += delta.noData;
            totalSites += delta.success + delta.error + delta.noData;
            if (delta.run) allCompletedRuns.push(delta.run);
            // Fire-and-forget DB update — don't await to avoid slowing down the batch
            db.updateMonitoringBatchRun(batchId, {
              totalSites,
              successCount: totalSuccess,
              errorCount: totalError,
              noDataCount: totalNoData,
            }).catch(() => {});
          },
        }
      );

      // Reconcile final counts from executeProviderRun (authoritative)
      // The onSiteProgress callbacks already incremented, so don't double-count
      providersCompleted++;

      await db.updateMonitoringBatchRun(batchId, {
        providersCompleted,
        totalSites,
        successCount: totalSuccess,
        errorCount: totalError,
        noDataCount: totalNoData,
      });
    }

    // Push successful runs to Converted Reads dataset for Performance Ratio tab
    const successfulRuns = allCompletedRuns.filter(
      (r) => r.status === "success" && r.lifetimeKwh != null && r.lifetimeKwh > 0
    );
    console.log(
      `[MonitoringBatch] Collected ${allCompletedRuns.length} total runs, ${successfulRuns.length} with lifetime kWh data, ownerUserId=${ownerUserId}`
    );

    if (!ownerUserId) {
      console.warn("[MonitoringBatch] Skipping converted reads push: no ownerUserId resolved.");
    } else if (successfulRuns.length === 0) {
      console.warn("[MonitoringBatch] Skipping converted reads push: no successful runs with lifetime kWh.");
    } else {
      try {
        const { pushed, skipped } = await pushMonitoringRunsToConvertedReads(ownerUserId, allCompletedRuns);
        console.log(
          `[MonitoringBatch] Converted reads push complete: ${pushed} pushed, ${skipped} skipped (dedup). userId=${ownerUserId}`
        );
      } catch (err) {
        console.error(
          "[MonitoringBatch] Failed to push converted reads:",
          err instanceof Error ? err.message : err,
          err instanceof Error && err.stack ? `\n${err.stack}` : ""
        );
      }
    }

    await db.updateMonitoringBatchRun(batchId, {
      status: "completed",
      currentProvider: null,
      currentCredentialName: null,
      totalSites,
      successCount: totalSuccess,
      errorCount: totalError,
      noDataCount: totalNoData,
      completedAt: new Date(),
    });
  } catch (err) {
    console.error("[MonitoringBatch] Fatal error:", err);
    await db.updateMonitoringBatchRun(batchId, {
      status: "failed",
      currentProvider: null,
      currentCredentialName: null,
      totalSites,
      successCount: totalSuccess,
      errorCount: totalError,
      noDataCount: totalNoData,
      completedAt: new Date(),
    });
  }
}
