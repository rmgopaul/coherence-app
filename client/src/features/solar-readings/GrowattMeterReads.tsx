import { trpc } from "@/lib/trpc";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

const config: MeterReadsProviderConfig = {
  providerName: "Growatt",
  providerSlug: "growatt",
  convertedReadsMonitoring: "Growatt",
  pageTitle: "Growatt API",
  pageDescription:
    "Username/password connection for Growatt monitoring endpoints, including bulk CSV processing for thousands of plants.",
  connectDescription:
    "Save one or more API profiles, switch active profile, and persist credentials for future sessions.",

  idFieldName: "plantId",
  idFieldLabel: "Plant ID",
  idFieldLabelPlural: "Plant IDs",

  csvIdHeaders: ["plantid", "plant_id", "id"],

  credentialFields: [
    {
      name: "username",
      label: "Username",
      type: "text",
      placeholder: "Growatt Username",
    },
    {
      name: "password",
      label: "Password",
      type: "password",
      placeholder: "Growatt Password",
    },
  ],

  connectionDisplayField: "idSlice",

  singleOperations: [
    { value: "listPlants", label: "List Plants" },
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
  ],

  hasListItems: true,
  listItemsKey: "plants",

  useStatusQuery: (enabled) =>
    trpc.growatt.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.growatt.listPlants.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () =>
    trpc.growatt.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.growatt.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.growatt.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.growatt.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.growatt.getProductionSnapshot.useMutation(),

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.growatt.getStatus.invalidate();
    await u.growatt.listPlants.invalidate();
  },
};

export default function GrowattMeterReads() {
  return <MeterReadsPage config={config} />;
}
