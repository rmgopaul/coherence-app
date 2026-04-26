import { trpc } from "@/lib/trpc";
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, httpLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { getLoginUrl } from "./const";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Keep recent route data warm so page switches render instantly.
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
    },
    mutations: {
      retry: 1,
    },
  },
});

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;
  const loginUrl = getLoginUrl();
  if (loginUrl.startsWith("/") && window.location.pathname === loginUrl) {
    return;
  }
  window.location.href = loginUrl;
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcFetch: typeof fetch = async (input, init) => {
  const response = await globalThis.fetch(input, {
    ...(init ?? {}),
    credentials: "include",
  });

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/html")) {
    const statusPart = response.status ? ` (HTTP ${response.status})` : "";
    throw new Error(
      `API returned HTML instead of JSON${statusPart}. This usually happens when the app/server reconnects after sleep; refresh and retry.`
    );
  }

  return response;
};

const trpcClient = trpc.createClient({
  // After Task 5.5 (2026-04-26) `solarRecDashboard.*` is no longer on
  // the main router — main-app callers that still need it import
  // `solarRecTrpc` from `@/solar-rec/solarRecTrpc` and call the
  // standalone client (provider wired below). This keeps the main tRPC
  // client to a single batched httpLink without splitLink branching.
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch: trpcFetch,
    }),
  ],
});

// Solar REC standalone tRPC client — wired into the main app so pages
// that still call `solarRecDashboard.*` (Task 5.9-5.11 wrong-side
// features awaiting their own migration: AbpInvoiceSettlement,
// EarlyPayment, DeepUpdateSynthesizer, etc.) can hit the standalone
// router. The dashboard procedures use `httpLink` with methodOverride
// POST because some payloads (CSV uploads, dataset writes) exceed the
// batched-link size budget.
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
        <App />
      </QueryClientProvider>
    </solarRecTrpc.Provider>
  </trpc.Provider>
);
