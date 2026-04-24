import { trpc } from "@/lib/trpc";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

/**
 * Hoymiles S-Miles Cloud page — migrated from 1,321-LOC hand-rolled
 * page onto the shared MeterReadsPage component (Task 4.7).
 *
 * Hoymiles is production-only with a username/password credential
 * flow. Server snapshot fields (stationId/name/lifetimeKwh/daily/
 * monthly/last12Months/anchorDate) already match BulkSnapshotRow.
 * Clean 1:1 swap — no bulkDataTypes, no adapter hooks.
 */

const config: MeterReadsProviderConfig = {
  providerName: "Hoymiles",
  providerSlug: "hoymiles",
  convertedReadsMonitoring: MONITORING_CANONICAL_NAMES.hoymiles,
  pageTitle: "Hoymiles S-Miles Cloud API",
  pageDescription:
    "Username/password connection for Hoymiles S-Miles Cloud, with bulk CSV processing for thousands of stations.",
  connectDescription:
    "Save one or more Hoymiles credential profiles, switch the active profile, and persist credentials for future sessions.",

  idFieldName: "stationId",
  idFieldLabel: "Station ID",
  idFieldLabelPlural: "Station IDs",

  csvIdHeaders: ["stationid", "station_id", "id"],

  credentialFields: [
    {
      name: "username",
      label: "Username",
      type: "text",
      placeholder: "Hoymiles Username",
    },
    {
      name: "password",
      label: "Password",
      type: "password",
      placeholder: "Hoymiles Password",
    },
  ],

  connectionDisplayField: "usernameMasked",
  savedProfilesLabel: "Saved API Profiles",

  singleOperations: [
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
    { value: "listStations", label: "List Stations" },
  ],

  hasListItems: true,
  listItemsKey: "stations",

  useStatusQuery: (enabled) =>
    trpc.hoymiles.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.hoymiles.listStations.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () => trpc.hoymiles.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.hoymiles.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.hoymiles.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.hoymiles.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.hoymiles.getProductionSnapshot.useMutation(),

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.hoymiles.getStatus.invalidate();
    await u.hoymiles.listStations.invalidate();
  },
};

export default function HoymilesMeterReads() {
  return <MeterReadsPage config={config} />;
}
