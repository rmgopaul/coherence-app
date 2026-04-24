import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import { ExternalLink } from "lucide-react";
import MeterReadsPage from "./shared/MeterReadsPage";
import type { MeterReadsProviderConfig } from "./shared/types";

/**
 * Enphase V4 page — migrated from 695-LOC hand-rolled page onto the
 * shared MeterReadsPage component (Task 4.7, final vendor).
 *
 * Enphase V4 uses OAuth — users click an Authorize link that opens
 * Enphase's consent page, return with a one-time `code=...` in the
 * URL, and paste that code back into the form. The shared page's
 * plain `credentialFields` grid handles the six inputs; the new
 * `preConnectContent` config slot renders the dynamic authorize URL
 * button that consumes the live clientId + redirectUri values as
 * the user types.
 */

const DEFAULT_BASE_URL = "https://api.enphaseenergy.com/api/v4";
const DEFAULT_REDIRECT_URI =
  "https://api.enphaseenergy.com/oauth/redirect_uri";

function buildEnphaseAuthorizeUrl(
  clientId: string | undefined,
  redirectUri: string | undefined
): string {
  const normalizedClientId = (clientId ?? "").trim();
  if (!normalizedClientId) return "";
  const normalizedRedirect =
    (redirectUri ?? "").trim() || DEFAULT_REDIRECT_URI;
  const url = new URL("https://api.enphaseenergy.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", normalizedClientId);
  url.searchParams.set("redirect_uri", normalizedRedirect);
  return url.toString();
}

const config: MeterReadsProviderConfig = {
  providerName: "Enphase v4",
  providerSlug: "enphase-v4",
  convertedReadsMonitoring: MONITORING_CANONICAL_NAMES.enphase,
  pageTitle: "Enphase Monitoring API (v4)",
  pageDescription:
    "OAuth-based connection to Enphase Cloud — enter your API key + client credentials, authorize in a new tab, paste the code back, and fetch production snapshots.",
  connectDescription:
    "Save your Enphase app credentials, click Authorize to get an authorization code, paste it back, then Connect.",

  idFieldName: "systemId",
  idFieldLabel: "System ID",
  idFieldLabelPlural: "System IDs",

  csvIdHeaders: ["system_id", "systemid", "system", "site_id", "id"],

  credentialFields: [
    {
      name: "apiKey",
      label: "API Key",
      type: "password",
      placeholder: "Enphase API Key",
    },
    {
      name: "clientId",
      label: "Client ID",
      type: "text",
      placeholder: "Enphase Client ID",
    },
    {
      name: "clientSecret",
      label: "Client Secret",
      type: "password",
      placeholder: "Enphase Client Secret",
    },
    {
      name: "authorizationCode",
      label: "Authorization Code",
      type: "text",
      placeholder:
        "Paste the ?code=... returned after clicking Authorize",
      helperText:
        "Single-use. Re-run the authorize flow to get a fresh code if needed.",
    },
    {
      name: "redirectUri",
      label: "Redirect URI",
      type: "text",
      placeholder: DEFAULT_REDIRECT_URI,
      optional: true,
      helperText: "Leave blank to use the default Enphase redirect URI.",
    },
    {
      name: "baseUrl",
      label: "API Base URL",
      type: "text",
      placeholder: DEFAULT_BASE_URL,
      optional: true,
      helperText: "Leave blank to use the default Enphase v4 host.",
    },
  ],

  connectionDisplayField: "apiKeyMasked",

  preConnectContent: ({ credentialValues, providerName }) => {
    const authUrl = buildEnphaseAuthorizeUrl(
      credentialValues.clientId,
      credentialValues.redirectUri
    );
    return (
      <div className="rounded-md border bg-muted/40 px-3 py-3 space-y-2">
        <p className="text-sm text-muted-foreground">
          Step 1: enter your Client ID above. Step 2: click{" "}
          <strong>Authorize</strong> to open {providerName}'s consent
          page. Step 3: copy the <code>?code=</code> value from the
          redirected URL back into the Authorization Code field. Step 4:
          click <strong>Connect</strong>.
        </p>
        <Button
          asChild={Boolean(authUrl)}
          variant="outline"
          size="sm"
          disabled={!authUrl}
        >
          {authUrl ? (
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              Authorize in Enphase
            </a>
          ) : (
            <span>
              <ExternalLink className="h-4 w-4 mr-2" />
              Enter Client ID to enable
            </span>
          )}
        </Button>
      </div>
    );
  },

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
    trpc.enphaseV4.getStatus.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  useListItemsQuery: (enabled) =>
    trpc.enphaseV4.listSystems.useQuery(undefined, {
      enabled,
      retry: false,
    }),

  // Enphase V4's `connect` returns `{success, hasRefreshToken,
  // expiresInSeconds}` — shim to the shared `ConnectResult` shape
  // (`{activeConnectionId, totalConnections}`) since there's one
  // OAuth token per user.
  useConnectMutation: () => {
    const mutation = trpc.enphaseV4.connect.useMutation();
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mutateAsync: async (input: any) => {
        await mutation.mutateAsync(input);
        return { activeConnectionId: "default", totalConnections: 1 };
      },
      isPending: mutation.isPending,
    };
  },
  // Enphase V4 stores a single connection (one OAuth token per user).
  // setActive/remove are no-ops that keep the shared page's profile
  // selector UI consistent.
  useSetActiveConnectionMutation: () => ({
    mutateAsync: async () => ({ success: true }),
    isPending: false,
  }),
  useRemoveConnectionMutation: () => ({
    mutateAsync: async () => ({
      connected: false,
      activeConnectionId: null,
      totalConnections: 0,
    }),
    isPending: false,
  }),
  useDisconnectMutation: () =>
    trpc.enphaseV4.disconnect.useMutation(),
  // Only a batch `getProductionSnapshots` is exposed server-side;
  // wrap it single-call so the shared page's per-ID loop works.
  useProductionSnapshotMutation: () => {
    const mutation = trpc.enphaseV4.getProductionSnapshots.useMutation();
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mutateAsync: async (input: any) => {
        const systemId = (input?.systemId ?? "").toString().trim();
        if (!systemId) {
          return {
            status: "Error" as const,
            found: false,
            error: "Missing System ID.",
          };
        }
        const result = await mutation.mutateAsync({
          systemIds: [systemId],
          anchorDate: input?.anchorDate,
        });
        return (
          result.rows[0] ?? {
            status: "Error" as const,
            found: false,
            error: "No row returned by Enphase production API.",
          }
        );
      },
      isPending: mutation.isPending,
    };
  },

  invalidateQueries: async (utils) => {
    const u = utils as ReturnType<typeof trpc.useUtils>;
    await u.enphaseV4.getStatus.invalidate();
    await u.enphaseV4.listSystems.invalidate();
  },
};

export default function EnphaseV4MeterReads() {
  return <MeterReadsPage config={config} />;
}
