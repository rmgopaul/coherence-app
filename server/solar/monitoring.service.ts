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
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a human-readable label from a credential's metadata (username, account, apiKey prefix). */
function extractCredentialLabel(
  cred: { connectionName?: string | null; metadata?: string | null; accessToken?: string | null } | undefined
): string | null {
  if (!cred) return null;
  if (cred.connectionName) return cred.connectionName;
  if (!cred.metadata) return cred.accessToken ? `...${cred.accessToken.slice(-6)}` : null;
  try {
    const meta = JSON.parse(cred.metadata);
    // Try common fields that identify the login
    return meta.username ?? meta.account ?? meta.connectionName
      ?? (meta.apiKey ? `Key ...${meta.apiKey.slice(-6)}` : null);
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------
// Execute a single provider run
// ---------------------------------------------------------------------------

export async function executeProviderRun(
  provider: string,
  dateKey: string,
  triggeredBy: number | null,
  options?: {
    credentialIds?: string[];
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
    return { success: 0, error: 0, noData: 0 };
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
          const results = await adapter.getSnapshots(cred, [site.siteId], dateKey);
          const result = results[0];
          const durationMs = Date.now() - start;

          if (!result || result.status === "Not Found") {
            noData++;
            return {
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
          }

          if (result.status === "Error") {
            error++;
            return {
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
          }

          success++;
          return {
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
        } catch (err) {
          error++;
          return {
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
        }
      });

      // Persist all results
      for (const snap of snapshots) {
        await db.upsertMonitoringApiRun({ id: nanoid(), ...snap });
      }
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

    let providersCompleted = 0;
    for (const provider of providers) {
      const providerCredentials = scopedCredentials.filter((credential) => credential.provider === provider);
      if (providerCredentials.length === 0) {
        providersCompleted++;
        continue;
      }

      // Find credential name for this provider
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
        }
      );
      totalSuccess += success;
      totalError += error;
      totalNoData += noData;
      totalSites += success + error + noData;
      providersCompleted++;

      await db.updateMonitoringBatchRun(batchId, {
        providersCompleted,
        totalSites,
        successCount: totalSuccess,
        errorCount: totalError,
        noDataCount: totalNoData,
      });
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
