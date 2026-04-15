import { trpc } from "@/lib/trpc";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

const config: MeterReadsProviderConfig = {
  providerName: "Solar-Log",
  providerSlug: "solarlog",
  convertedReadsMonitoring: MONITORING_CANONICAL_NAMES.solarLog,
  pageTitle: "Solar-Log Device API",
  pageDescription:
    "LAN-based connection for Solar-Log data loggers. The Device URL is typically a local IP address (e.g. http://192.168.1.x). Includes bulk CSV processing for production snapshots.",
  connectDescription:
    "Save one or more device profiles, switch active profile, and persist connection settings for future sessions.",
  savedProfilesLabel: "Saved Device Profiles",

  idFieldName: "deviceId",
  idFieldLabel: "Device ID",
  idFieldLabelPlural: "Device IDs",

  csvIdHeaders: ["deviceid", "device_id", "id"],

  credentialFields: [
    {
      name: "baseUrl",
      label: "Device URL",
      type: "text",
      placeholder: "http://192.168.1.x",
      helperText:
        "Solar-Log is a LAN-only device. Enter the local IP or hostname of the data logger.",
    },
    {
      name: "password",
      label: "Password",
      type: "password",
      placeholder: "Device password (if set)",
      optional: true,
    },
  ],

  connectionDisplayField: "baseUrl",

  singleOperations: [
    {
      value: "listDevices",
      label: "List Devices",
    },
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
  ],

  hasListItems: true,
  listItemsKey: "devices",

  useStatusQuery: (enabled) =>
    trpc.solarLog.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.solarLog.listDevices.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () =>
    trpc.solarLog.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.solarLog.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.solarLog.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.solarLog.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.solarLog.getProductionSnapshot.useMutation(),

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.solarLog.getStatus.invalidate();
    await u.solarLog.listDevices.invalidate();
  },
};

export default function SolarLogMeterReads() {
  return <MeterReadsPage config={config} />;
}
