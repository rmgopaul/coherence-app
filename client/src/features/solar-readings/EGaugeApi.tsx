import { trpc } from "@/lib/trpc";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

/**
 * eGauge page — migrated from 1,570-LOC hand-rolled page onto the
 * shared MeterReadsPage component (Task 4.7).
 *
 * eGauge uses the new `noBulkFetch` flag. Unlike other vendors, each
 * saved profile IS a meter/device (local eGauge units addressed by
 * URL, or portfolio-mode accounts that return all systems in a
 * single call). There's no central pool of IDs to upload and loop
 * over — the shared page's bulk CSV flow doesn't apply. Section 3 is
 * hidden; users manage meters via saved profiles + the single-
 * operation tester.
 *
 * Access-type dropdown uses the new select-type CredentialField.
 * Username/password are optional for public meters and required for
 * user_login / site_login / portfolio_login; server validates the
 * combination at connect time.
 */

const config: MeterReadsProviderConfig = {
  providerName: "eGauge",
  providerSlug: "egauge",
  convertedReadsMonitoring: MONITORING_CANONICAL_NAMES.egauge,
  pageTitle: "eGauge API",
  pageDescription:
    "Save eGauge profiles (public link, credentialed login, or portfolio account) and run single-meter production snapshots.",
  connectDescription:
    "Save one or more eGauge profiles, switch the active profile, and persist credentials for future sessions.",

  idFieldName: "meterId",
  idFieldLabel: "Meter ID",
  idFieldLabelPlural: "Meter IDs",

  csvIdHeaders: ["meterid", "meter_id", "id"],

  credentialFields: [
    {
      name: "baseUrl",
      label: "eGauge URL",
      type: "text",
      placeholder:
        "https://YOUR-METER.d.egauge.net or https://www.egauge.net",
      helperText:
        "Point to a specific device for meter mode, or www.egauge.net for portfolio mode.",
    },
    {
      name: "accessType",
      label: "Access Type",
      type: "select",
      placeholder: "Select access type",
      options: [
        { value: "public", label: "Public (no credentials)" },
        { value: "user_login", label: "User Login" },
        { value: "site_login", label: "Site Login" },
        { value: "portfolio_login", label: "Portfolio Login" },
      ],
    },
    {
      name: "username",
      label: "Username",
      type: "text",
      placeholder: "eGauge username",
      optional: true,
      helperText:
        "Required for user_login, site_login, and portfolio_login.",
    },
    {
      name: "password",
      label: "Password",
      type: "password",
      placeholder: "eGauge password",
      optional: true,
      helperText:
        "Required for user_login, site_login, and portfolio_login.",
    },
    {
      name: "meterId",
      label: "Meter ID",
      type: "text",
      placeholder: "e.g. egauge12345",
      optional: true,
      helperText:
        "Optional label; useful when saving several device profiles.",
    },
  ],

  connectionDisplayField: "usernameMasked",
  savedProfilesLabel: "Saved Meter Profiles",

  singleOperations: [
    {
      value: "getProductionSnapshot",
      label: "Get Production Snapshot",
    },
  ],

  hasListItems: false,
  noBulkFetch: true,

  useStatusQuery: (enabled) =>
    trpc.egauge.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useConnectMutation: () => trpc.egauge.connect.useMutation(),
  useSetActiveConnectionMutation: () =>
    trpc.egauge.setActiveConnection.useMutation(),
  useRemoveConnectionMutation: () =>
    trpc.egauge.removeConnection.useMutation(),
  useDisconnectMutation: () =>
    trpc.egauge.disconnect.useMutation(),
  useProductionSnapshotMutation: () =>
    trpc.egauge.getProductionSnapshots.useMutation(),

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.egauge.getStatus.invalidate();
  },
};

export default function EGaugeApi() {
  return <MeterReadsPage config={config} />;
}
