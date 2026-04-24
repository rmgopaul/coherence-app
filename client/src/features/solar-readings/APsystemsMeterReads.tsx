import { trpc } from "@/lib/trpc";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

/**
 * APsystems page — migrated from 1,349-LOC hand-rolled page onto
 * the shared MeterReadsPage component (Task 4.7).
 *
 * APsystems is production-only, single-connection focused, uses
 * appId + appSecret credentials. Server snapshot fields already
 * match the shared BulkSnapshotRow shape. Clean 1:1 swap — no
 * bulkDataTypes needed, no adapter hooks.
 */

const config: MeterReadsProviderConfig = {
  providerName: "APsystems",
  providerSlug: "apsystems",
  convertedReadsMonitoring: MONITORING_CANONICAL_NAMES.apsystems,
  pageTitle: "APsystems EMA API",
  pageDescription:
    "App ID + secret connection for APsystems EMA monitoring, with bulk CSV processing for thousands of ECU / system IDs.",
  connectDescription:
    "Save one or more APsystems App ID/Secret profiles, switch the active profile, and persist credentials for future sessions.",

  idFieldName: "systemId",
  idFieldLabel: "System ID",
  idFieldLabelPlural: "System IDs",

  csvIdHeaders: ["systemid", "system_id", "ecu_id", "id"],

  credentialFields: [
    {
      name: "appId",
      label: "App ID",
      type: "text",
      placeholder: "APsystems App ID",
    },
    {
      name: "appSecret",
      label: "App Secret",
      type: "password",
      placeholder: "APsystems App Secret",
    },
  ],

  connectionDisplayField: "apiKeyMasked",
  savedProfilesLabel: "Saved API Profiles",

  singleOperations: [
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
    { value: "listSystems", label: "List Systems" },
  ],

  hasListItems: true,
  listItemsKey: "systems",

  useStatusQuery: (enabled) =>
    trpc.apsystems.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.apsystems.listSystems.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () => trpc.apsystems.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.apsystems.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.apsystems.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.apsystems.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.apsystems.getProductionSnapshot.useMutation(),

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.apsystems.getStatus.invalidate();
    await u.apsystems.listSystems.invalidate();
  },
};

export default function APsystemsMeterReads() {
  return <MeterReadsPage config={config} />;
}
