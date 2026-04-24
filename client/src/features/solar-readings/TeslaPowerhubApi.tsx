import { trpc } from "@/lib/trpc";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

/**
 * Tesla Powerhub page — migrated from 823-LOC hand-rolled dev-tester
 * onto the shared MeterReadsPage component (Task 4.7).
 *
 * Tesla Powerhub is different from other vendors: a single snapshot
 * call fetches the entire group of sites at once (there is no per-
 * site endpoint). The new server-side `getProductionSnapshot`
 * procedure runs the group query once per 5-minute window via an
 * in-memory cache (see `getTeslaPowerhubGroupProductionMetricsCached`
 * in `server/services/solar/teslaPowerhub.ts`), so the shared
 * page's per-ID bulk loop amortizes to a single upstream fetch.
 *
 * The Group ID is saved per-connection (in metadata) — users enter
 * it at connect time instead of per-query. See the server `connect`
 * procedure in `server/routers/jobRunners.ts`.
 */

const config: MeterReadsProviderConfig = {
  providerName: "Tesla Powerhub",
  providerSlug: "tesla-powerhub",
  convertedReadsMonitoring: MONITORING_CANONICAL_NAMES.teslaPowerhub,
  pageTitle: "Tesla Powerhub API",
  pageDescription:
    "Client credentials + Group ID connection for Tesla Powerhub; bulk CSV processing pulls production snapshots for thousands of sites, with one upstream fetch per group cached for 5 minutes.",
  connectDescription:
    "Save your Tesla Powerhub Client ID, Client Secret, and Group ID. The group snapshot powers listSites and bulk meter reads.",

  idFieldName: "siteId",
  idFieldLabel: "Site ID",
  idFieldLabelPlural: "Site IDs",

  csvIdHeaders: [
    "site_id",
    "siteid",
    "id",
    "site_external_id",
    "ste_id",
  ],

  credentialFields: [
    {
      name: "clientId",
      label: "Client ID",
      type: "text",
      placeholder: "Tesla Powerhub Client ID",
    },
    {
      name: "clientSecret",
      label: "Client Secret",
      type: "password",
      placeholder: "Tesla Powerhub Client Secret",
    },
    {
      name: "groupId",
      label: "Group ID",
      type: "text",
      placeholder: "Tesla Powerhub Group ID (UUID)",
      helperText:
        "The group whose sites this profile reads. Required for listSites and bulk snapshots.",
    },
    {
      name: "tokenUrl",
      label: "Token URL",
      type: "text",
      placeholder: "https://auth.tesla.com/oauth2/v3/token",
      optional: true,
      helperText: "Leave blank to use the Tesla Powerhub default.",
    },
    {
      name: "apiBaseUrl",
      label: "API Base URL",
      type: "text",
      placeholder: "https://fleet-api.prd.na.vn.cloud.tesla.com",
      optional: true,
      helperText: "Leave blank to use the Tesla Powerhub default.",
    },
  ],

  connectionDisplayField: "apiKeyMasked",
  savedProfilesLabel: "Saved API Profiles",

  singleOperations: [
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
    { value: "listSites", label: "List Sites" },
  ],

  hasListItems: true,
  listItemsKey: "sites",

  useStatusQuery: (enabled) =>
    trpc.teslaPowerhub.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.teslaPowerhub.listSites.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () =>
    trpc.teslaPowerhub.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.teslaPowerhub.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.teslaPowerhub.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.teslaPowerhub.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.teslaPowerhub.getProductionSnapshot.useMutation(),

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.teslaPowerhub.getStatus.invalidate();
    await u.teslaPowerhub.listSites.invalidate();
  },
};

export default function TeslaPowerhubApi() {
  return <MeterReadsPage config={config} />;
}
