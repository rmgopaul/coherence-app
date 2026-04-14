import { trpc } from "@/lib/trpc";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

const config: MeterReadsProviderConfig = {
  providerName: "GoodWe",
  providerSlug: "goodwe",
  convertedReadsMonitoring: "GoodWe",
  pageTitle: "GoodWe SEMS API",
  pageDescription:
    "Account/password connection for GoodWe SEMS Portal endpoints, including bulk CSV processing for production snapshots.",
  connectDescription:
    "Save one or more API profiles, switch active profile, and persist credentials for future sessions.",

  idFieldName: "stationId",
  idFieldLabel: "Station ID",
  idFieldLabelPlural: "Station IDs",

  csvIdHeaders: [
    "stationid",
    "station_id",
    "powerstation_id",
    "id",
  ],

  credentialFields: [
    {
      name: "account",
      label: "Account",
      type: "text",
      placeholder: "GoodWe SEMS Account",
    },
    {
      name: "password",
      label: "Password",
      type: "password",
      placeholder: "GoodWe SEMS Password",
    },
  ],

  connectionDisplayField: "accountMasked",

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
    trpc.goodwe.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.goodwe.listStations.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () =>
    trpc.goodwe.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.goodwe.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.goodwe.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.goodwe.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.goodwe.getProductionSnapshot.useMutation(),

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.goodwe.getStatus.invalidate();
    await u.goodwe.listStations.invalidate();
  },
};

export default function GoodWeMeterReads() {
  return <MeterReadsPage config={config} />;
}
