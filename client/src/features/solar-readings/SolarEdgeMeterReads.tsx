import { trpc } from "@/lib/trpc";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

/**
 * SolarEdge page — migrated from 1,613-LOC hand-rolled page onto the
 * shared `MeterReadsPage` component (Task 4.7 / PR #33 extension).
 *
 * SolarEdge exposes three bulk data types (production / meters /
 * inverters). The server batch procedures `getProductionSnapshots`,
 * `getMeterSnapshots`, and `getInverterSnapshots` each accept
 * `siteIds: string[]`; the shared page calls mutations one ID at a
 * time. The adapters below translate each single-ID call into a
 * single-element batch call and unwrap `rows[0]`.
 */

type BatchInput = {
  siteId?: string;
  anchorDate?: string;
  connectionScope?: "active" | "all";
};

function useMetersAdapter() {
  const mutation = trpc.solarEdge.getMeterSnapshots.useMutation();
  return {
    mutateAsync: async (input: BatchInput) => {
      const siteId = (input.siteId ?? "").trim();
      if (!siteId) {
        return {
          status: "Error" as const,
          found: false,
          error: "Missing Site ID.",
        };
      }
      const result = await mutation.mutateAsync({
        siteIds: [siteId],
        connectionScope: input.connectionScope ?? "active",
      });
      return (
        result.rows[0] ?? {
          status: "Error" as const,
          found: false,
          error: "No row returned by SolarEdge meters API.",
        }
      );
    },
    isPending: mutation.isPending,
  };
}

function useInvertersAdapter() {
  const mutation = trpc.solarEdge.getInverterSnapshots.useMutation();
  return {
    mutateAsync: async (input: BatchInput) => {
      const siteId = (input.siteId ?? "").trim();
      if (!siteId) {
        return {
          status: "Error" as const,
          found: false,
          error: "Missing Site ID.",
        };
      }
      const result = await mutation.mutateAsync({
        siteIds: [siteId],
        anchorDate: input.anchorDate,
        connectionScope: input.connectionScope ?? "active",
      });
      return (
        result.rows[0] ?? {
          status: "Error" as const,
          found: false,
          error: "No row returned by SolarEdge inverters API.",
        }
      );
    },
    isPending: mutation.isPending,
  };
}

const config: MeterReadsProviderConfig = {
  providerName: "SolarEdge",
  providerSlug: "solaredge",
  convertedReadsMonitoring: MONITORING_CANONICAL_NAMES.solarEdge,
  pageTitle: "SolarEdge Monitoring API",
  pageDescription:
    "API key connection for SolarEdge monitoring, with bulk CSV processing for production / meters / inverters across thousands of sites.",
  connectDescription:
    "Save one or more SolarEdge API keys, switch the active profile, and persist credentials for future sessions.",

  idFieldName: "siteId",
  idFieldLabel: "Site ID",
  idFieldLabelPlural: "Site IDs",

  csvIdHeaders: [
    "site_id",
    "siteid",
    "site",
    "site_number",
    "site_number_id",
    "id",
  ],

  credentialFields: [
    {
      name: "apiKey",
      label: "API Key",
      type: "password",
      placeholder: "SolarEdge API Key",
    },
    {
      name: "baseUrl",
      label: "Base URL",
      type: "text",
      placeholder: "https://monitoringapi.solaredge.com",
      optional: true,
      helperText:
        "Leave blank to use the default SolarEdge monitoring host.",
    },
  ],

  connectionDisplayField: "apiKeyMasked",
  savedProfilesLabel: "Saved API Profiles",

  singleOperations: [
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
    { value: "listSites", label: "List Sites" },
  ],

  bulkDataTypes: [
    { value: "production", label: "Production Snapshot" },
    { value: "meters", label: "Meter Inventory" },
    { value: "inverters", label: "Inverter Snapshot" },
  ],

  hasListItems: true,
  listItemsKey: "sites",

  useStatusQuery: (enabled) =>
    trpc.solarEdge.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.solarEdge.listSites.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () => trpc.solarEdge.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.solarEdge.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.solarEdge.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.solarEdge.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.solarEdge.getProductionSnapshot.useMutation(),

  useBulkSnapshotMutationByType: {
    meters: useMetersAdapter,
    inverters: useInvertersAdapter,
  },

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.solarEdge.getStatus.invalidate();
    await u.solarEdge.listSites.invalidate();
  },
};

export default function SolarEdgeMeterReads() {
  return <MeterReadsPage config={config} />;
}
