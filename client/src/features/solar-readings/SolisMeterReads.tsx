import { trpc } from "@/lib/trpc";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

const config: MeterReadsProviderConfig = {
  providerName: "Solis",
  providerSlug: "solis",
  convertedReadsMonitoring: "Solis",
  pageTitle: "Solis Cloud API",
  pageDescription:
    "API Key/Secret connection for Solis Cloud monitoring endpoints, including bulk CSV processing for production snapshots.",
  connectDescription:
    "Save one or more API profiles, switch active profile, and persist API keys for future sessions.",

  idFieldName: "stationId",
  idFieldLabel: "Station ID",
  idFieldLabelPlural: "Station IDs",

  csvIdHeaders: ["stationid", "station_id", "id"],

  credentialFields: [
    {
      name: "apiKey",
      label: "API Key",
      type: "password",
      placeholder: "Solis Cloud API Key",
    },
    {
      name: "apiSecret",
      label: "API Secret",
      type: "password",
      placeholder: "Solis Cloud API Secret",
    },
  ],

  connectionDisplayField: "apiKeyMasked",

  singleOperations: [
    {
      value: "listStations",
      label: "List Stations",
    },
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
  ],

  hasListItems: true,
  listItemsKey: "stations",

  useStatusQuery: (enabled) =>
    trpc.solis.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.solis.listStations.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () =>
    trpc.solis.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.solis.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.solis.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.solis.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.solis.getProductionSnapshot.useMutation(),

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.solis.getStatus.invalidate();
    await u.solis.listStations.invalidate();
  },
};

export default function SolisMeterReads() {
  return <MeterReadsPage config={config} />;
}
