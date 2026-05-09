import { trpc } from "@/lib/trpc";
import { solarRecTrpc } from "./solar-rec/solarRecTrpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import SolarRecApp from "./solar-rec/SolarRecApp";
import "./index.css";
// Phase E (2026-04-28) — register the PWA service worker on boot.
// No-ops in dev and on unsupported browsers; surfaces an "Update
// available" toast when a new build reaches `installed`.
import { registerServiceWorker } from "./lib/registerServiceWorker";
// 2026-05-09 follow-up to PR-6 (#535): apply the dashboard retry
// policy as the QueryClient default + plumb the server's
// `Retry-After` header into tRPC client errors so the policy can
// honor it. See `solar-rec-dashboard/lib/dashboardRetryPolicy.ts`
// + `dashboardRetryAfter.ts` for the per-mechanism docstrings.
import {
  dashboardTransientRetryDelay,
  shouldRetryDashboardTransient,
} from "./solar-rec-dashboard/lib/dashboardRetryPolicy";
import { wrapFetchWithRetryAfterCapture } from "./solar-rec-dashboard/lib/dashboardRetryAfter";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      // 2026-05-09 follow-up: replace the unfiltered `retry: 2`
      // default with the dashboard transient-retry policy. Pre-fix
      // every query in the solar-rec app retried on 4xx-other
      // (e.g. 401 after token expiry), uselessly burning network +
      // server quota on deterministic errors. The policy retries
      // only 429/502/503/504 (transient overload) up to 3 retries,
      // honors the server's `Retry-After` floor when present, and
      // falls back to jittered exponential backoff otherwise. Per-
      // query overrides on the 3 systems-page tabs (Comparisons /
      // Alerts / Ownership) become redundant after this default —
      // dropping them is a follow-up cleanup, not behavioral.
      retry: shouldRetryDashboardTransient,
      retryDelay: dashboardTransientRetryDelay,
    },
    mutations: {
      // Mutations stay at the legacy 2-retry default. The transient-
      // retry policy is appropriate for read paths (idempotent by
      // construction); applying it to mutations could cause the
      // server to receive the same write twice during a 502 retry
      // window. Only opt mutations into the policy when the writer
      // is explicitly idempotent (e.g. `applyScheduleBToDelivery
      // Obligations` after PR-FU-3 ships its semaphore).
      retry: 2,
    },
  },
});

const baseFetch: typeof fetch = async (input, init) => {
  const response = await globalThis.fetch(input, {
    ...(init ?? {}),
    credentials: "include",
  });

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/html")) {
    const statusPart = response.status ? ` (HTTP ${response.status})` : "";
    throw new Error(
      `API returned HTML instead of JSON${statusPart}. Refresh and retry.`
    );
  }

  return response;
};

// 2026-05-09 follow-up: wrap the fetch so transient-overload
// responses (429/503/502/504) with a `Retry-After` header have the
// header value plumbed into the tRPC client error's
// `data.retryAfterMs` field. The retry policy reads it and uses
// `max(retryAfterMs, jitteredDelay)` so the server's hint wins
// when it would force a longer wait. See `dashboardRetryAfter.ts`.
const trpcFetch = wrapFetchWithRetryAfterCapture(baseFetch);

// Main app trpc instance used by meter read pages and shared dashboard helpers.
// Route this client directly to the main-trpc endpoint to avoid split-routing
// edge cases in production. After Task 5.5 (2026-04-26) `solarRecDashboard.*`
// is no longer on the main router — pages that need it import `solarRecTrpc`
// (which targets /solar-rec/api/trpc) directly.
const trpcClient = trpc.createClient({
  links: [
    httpLink({
      url: "/solar-rec/api/main-trpc",
      methodOverride: "POST",
      transformer: superjson,
      fetch: trpcFetch,
    }),
  ],
});

// Solar REC typed trpc instance (for Settings, Monitoring, etc.)
const solarRecTrpcClient = solarRecTrpc.createClient({
  links: [
    httpLink({
      url: "/solar-rec/api/trpc",
      methodOverride: "POST",
      transformer: superjson,
      fetch: trpcFetch,
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <solarRecTrpc.Provider client={solarRecTrpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <SolarRecApp />
      </QueryClientProvider>
    </solarRecTrpc.Provider>
  </trpc.Provider>
);

registerServiceWorker();
