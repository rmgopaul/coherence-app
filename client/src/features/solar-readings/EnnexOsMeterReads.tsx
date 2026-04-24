import { trpc } from "@/lib/trpc";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

/**
 * ennexOS page — migrated from 1,584-LOC hand-rolled page onto the
 * shared MeterReadsPage component (Task 4.7, third use of
 * `bulkDataTypes` after SolarEdge #35 and Fronius #36).
 *
 * ennexOS exposes two bulk data types: production and devices. The
 * server already has a singular `getProductionSnapshot` whose fields
 * match BulkSnapshotRow so the production mutation plugs in
 * directly. Devices is only exposed as a batch procedure
 * (`getDeviceSnapshots`); the adapter wraps it as a single-element
 * `plantIds: [id]` call and unwraps `rows[0]` — same pattern as
 * SolarEdge's meter/inverter adapters.
 */

type BatchInput = {
  plantId?: string;
  anchorDate?: string;
  connectionScope?: "active" | "all";
};

function useDevicesAdapter() {
  const mutation = trpc.ennexOs.getDeviceSnapshots.useMutation();
  return {
    mutateAsync: async (input: BatchInput) => {
      const plantId = (input.plantId ?? "").trim();
      if (!plantId) {
        return {
          status: "Error" as const,
          found: false,
          error: "Missing Plant ID.",
        };
      }
      const result = await mutation.mutateAsync({
        plantIds: [plantId],
        anchorDate: input.anchorDate,
        connectionScope: input.connectionScope ?? "active",
      });
      return (
        result.rows[0] ?? {
          status: "Error" as const,
          found: false,
          error: "No row returned by ennexOS devices API.",
        }
      );
    },
    isPending: mutation.isPending,
  };
}

const config: MeterReadsProviderConfig = {
  providerName: "ennexOS",
  providerSlug: "ennexos",
  convertedReadsMonitoring: MONITORING_CANONICAL_NAMES.ennexos,
  pageTitle: "ennexOS (SMA) API",
  pageDescription:
    "Access-token connection for SMA ennexOS / Sunny Portal; bulk CSV processing for production snapshots and device inventories across thousands of plants.",
  connectDescription:
    "Save one or more ennexOS API tokens, switch the active profile, and persist credentials for future sessions.",

  idFieldName: "plantId",
  idFieldLabel: "Plant ID",
  idFieldLabelPlural: "Plant IDs",

  csvIdHeaders: ["plant_id", "plantid", "plant", "plant_number", "id"],

  credentialFields: [
    {
      name: "accessToken",
      label: "Access Token",
      type: "password",
      placeholder: "ennexOS / SMA API Access Token",
    },
    {
      name: "baseUrl",
      label: "Base URL",
      type: "text",
      placeholder: "https://sandbox.smaapis.de",
      optional: true,
      helperText:
        "Leave blank to use the default ennexOS host.",
    },
  ],

  connectionDisplayField: "accessKeyIdMasked",
  savedProfilesLabel: "Saved API Profiles",

  singleOperations: [
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
    { value: "listPlants", label: "List Plants" },
  ],

  bulkDataTypes: [
    { value: "production", label: "Production Snapshot" },
    { value: "devices", label: "Device Inventory" },
  ],

  hasListItems: true,
  listItemsKey: "plants",

  useStatusQuery: (enabled) =>
    trpc.ennexOs.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.ennexOs.listPlants.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () => trpc.ennexOs.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.ennexOs.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.ennexOs.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.ennexOs.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.ennexOs.getProductionSnapshot.useMutation(),

  useBulkSnapshotMutationByType: {
    devices: useDevicesAdapter,
  },

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.ennexOs.getStatus.invalidate();
    await u.ennexOs.listPlants.invalidate();
  },
};

export default function EnnexOsMeterReads() {
  return <MeterReadsPage config={config} />;
}
