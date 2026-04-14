import { trpc } from "@/lib/trpc";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

const config: MeterReadsProviderConfig = {
  providerName: "Generac",
  providerSlug: "generac",
  convertedReadsMonitoring: "Generac",
  pageTitle: "Generac PWRview API",
  pageDescription:
    "API Key connection for Generac PWRview monitoring endpoints, including bulk CSV processing for production snapshots.",
  connectDescription:
    "Save one or more API profiles, switch active profile, and persist API keys for future sessions.",

  idFieldName: "systemId",
  idFieldLabel: "System ID",
  idFieldLabelPlural: "System IDs",

  csvIdHeaders: ["systemid", "system_id", "id"],

  credentialFields: [
    {
      name: "apiKey",
      label: "API Key",
      type: "password",
      placeholder: "Generac API Key",
    },
  ],

  connectionDisplayField: "apiKeyMasked",

  singleOperations: [
    {
      value: "listSystems",
      label: "List Systems",
    },
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
  ],

  hasListItems: true,
  listItemsKey: "systems",

  useStatusQuery: (enabled) =>
    trpc.generac.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.generac.listSystems.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () =>
    trpc.generac.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.generac.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.generac.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.generac.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.generac.getProductionSnapshot.useMutation(),

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.generac.getStatus.invalidate();
    await u.generac.listSystems.invalidate();
  },
};

export default function GeneracMeterReads() {
  return <MeterReadsPage config={config} />;
}
