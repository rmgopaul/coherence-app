import { trpc } from "@/lib/trpc";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

/**
 * Fronius page — migrated from 1,651-LOC hand-rolled page onto the
 * shared MeterReadsPage component (Task 4.7, PR #33 extension).
 *
 * Fronius exposes two bulk data types: production and devices. The
 * server already has a singular `getProductionSnapshot` procedure
 * whose response matches the shared BulkSnapshotRow shape, so the
 * production mutation plugs in directly. Devices is only exposed as
 * a batch procedure (`getDeviceSnapshots`); the adapter wraps it as
 * a single-element `pvSystemIds: [id]` call and unwraps `rows[0]`.
 */

type BatchInput = {
  pvSystemId?: string;
  anchorDate?: string;
  connectionScope?: "active" | "all";
};

function useDevicesAdapter() {
  const mutation = trpc.fronius.getDeviceSnapshots.useMutation();
  return {
    mutateAsync: async (input: BatchInput) => {
      const pvSystemId = (input.pvSystemId ?? "").trim();
      if (!pvSystemId) {
        return {
          status: "Error" as const,
          found: false,
          error: "Missing PV System ID.",
        };
      }
      const result = await mutation.mutateAsync({
        pvSystemIds: [pvSystemId],
        connectionScope: input.connectionScope ?? "active",
      });
      return (
        result.rows[0] ?? {
          status: "Error" as const,
          found: false,
          error: "No row returned by Fronius devices API.",
        }
      );
    },
    isPending: mutation.isPending,
  };
}

const config: MeterReadsProviderConfig = {
  providerName: "Fronius",
  providerSlug: "fronius",
  convertedReadsMonitoring: MONITORING_CANONICAL_NAMES.fronius,
  pageTitle: "Fronius Solar.web API",
  pageDescription:
    "Access-key connection for Fronius Solar.web, with bulk CSV processing for production snapshots and device inventories across thousands of PV systems.",
  connectDescription:
    "Save one or more Fronius API access keys, switch the active profile, and persist credentials for future sessions.",

  idFieldName: "pvSystemId",
  idFieldLabel: "PV System ID",
  idFieldLabelPlural: "PV System IDs",

  csvIdHeaders: [
    "pvsystemid",
    "pv_system_id",
    "system_id",
    "systemid",
    "id",
  ],

  credentialFields: [
    {
      name: "accessKeyId",
      label: "Access Key ID",
      type: "text",
      placeholder: "Fronius Access Key ID",
    },
    {
      name: "accessKeyValue",
      label: "Access Key Secret",
      type: "password",
      placeholder: "Fronius Access Key Secret",
    },
  ],

  connectionDisplayField: "accessKeyIdMasked",
  savedProfilesLabel: "Saved API Profiles",

  singleOperations: [
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
    { value: "listPvSystems", label: "List PV Systems" },
  ],

  bulkDataTypes: [
    { value: "production", label: "Production Snapshot" },
    { value: "devices", label: "Device Inventory" },
  ],

  hasListItems: true,
  listItemsKey: "pvSystems",

  useStatusQuery: (enabled) =>
    trpc.fronius.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.fronius.listPvSystems.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () => trpc.fronius.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.fronius.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.fronius.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.fronius.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.fronius.getProductionSnapshot.useMutation(),

  useBulkSnapshotMutationByType: {
    devices: useDevicesAdapter,
  },

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.fronius.getStatus.invalidate();
    await u.fronius.listPvSystems.invalidate();
  },
};

export default function FroniusMeterReads() {
  return <MeterReadsPage config={config} />;
}
