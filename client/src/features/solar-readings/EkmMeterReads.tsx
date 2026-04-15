import { trpc } from "@/lib/trpc";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

const config: MeterReadsProviderConfig = {
  providerName: "EKM",
  providerSlug: "ekm",
  convertedReadsMonitoring: MONITORING_CANONICAL_NAMES.ekm,
  pageTitle: "EKM Metering API",
  pageDescription:
    "API Key connection for EKM meter reads, including bulk CSV processing for production snapshots.",
  connectDescription:
    "Save one or more API profiles, switch active profile, and persist API keys for future sessions.",

  idFieldName: "meterNumber",
  idFieldLabel: "Meter Number",
  idFieldLabelPlural: "Meter Numbers",

  csvIdHeaders: [
    "meternumber",
    "meter_number",
    "meter",
    "id",
  ],

  credentialFields: [
    {
      name: "apiKey",
      label: "API Key",
      type: "password",
      placeholder: "EKM API Key",
    },
  ],

  connectionDisplayField: "apiKeyMasked",

  singleOperations: [
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
  ],

  hasListItems: false,

  useStatusQuery: (enabled) =>
    trpc.ekm.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () =>
    trpc.ekm.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.ekm.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.ekm.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.ekm.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.ekm.getProductionSnapshot.useMutation(),

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.ekm.getStatus.invalidate();
  },
};

export default function EkmMeterReads() {
  return <MeterReadsPage config={config} />;
}
