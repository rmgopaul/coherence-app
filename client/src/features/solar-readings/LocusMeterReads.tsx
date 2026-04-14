import { trpc } from "@/lib/trpc";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

const config: MeterReadsProviderConfig = {
  providerName: "Locus",
  providerSlug: "locus",
  convertedReadsMonitoring: "Locus",
  pageTitle: "Locus Energy API",
  pageDescription:
    "Client ID/Secret/Partner ID connection for Locus Energy monitoring endpoints, including bulk CSV processing for production snapshots.",
  connectDescription:
    "Save one or more API profiles, switch active profile, and persist credentials for future sessions.",

  idFieldName: "siteId",
  idFieldLabel: "Site ID",
  idFieldLabelPlural: "Site IDs",

  csvIdHeaders: ["siteid", "site_id", "id"],

  credentialFields: [
    {
      name: "clientId",
      label: "Client ID",
      type: "password",
      placeholder: "Locus Energy Client ID",
    },
    {
      name: "clientSecret",
      label: "Client Secret",
      type: "password",
      placeholder: "Locus Energy Client Secret",
    },
    {
      name: "partnerId",
      label: "Partner ID",
      type: "password",
      placeholder: "Locus Energy Partner ID",
    },
  ],

  connectionDisplayField: "idSlice",

  singleOperations: [
    { value: "listSites", label: "List Sites" },
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
  ],

  hasListItems: true,
  listItemsKey: "sites",

  useStatusQuery: (enabled) =>
    trpc.locus.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.locus.listSites.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () =>
    trpc.locus.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.locus.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.locus.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.locus.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.locus.getProductionSnapshot.useMutation(),

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.locus.getStatus.invalidate();
    await u.locus.listSites.invalidate();
  },
};

export default function LocusMeterReads() {
  return <MeterReadsPage config={config} />;
}
