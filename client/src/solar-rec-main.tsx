import { trpc } from "@/lib/trpc";
import { solarRecTrpc } from "./solar-rec/solarRecTrpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpLink, splitLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import SolarRecApp from "./solar-rec/SolarRecApp";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: 2,
    },
    mutations: {
      retry: 2,
    },
  },
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
      `API returned HTML instead of JSON${statusPart}. Refresh and retry.`
    );
  }

  return response;
};

// Routes handled by the solar-rec tRPC router
const SOLAR_REC_ROUTES = new Set([
  "solarRecDashboard",
  "auth",
  "users",
  "credentials",
  "monitoring",
  "enphaseV2",
]);

// Main app trpc instance (for SolarRecDashboard + meter read pages).
// Uses splitLink: solar-rec routes go to the solar-rec endpoint,
// provider routes (solarEdge.*, enphaseV4.*, etc.) go to the main app endpoint.
const trpcClient = trpc.createClient({
  links: [
    splitLink({
      condition: (op) => SOLAR_REC_ROUTES.has(op.path.split(".")[0]),
      true: httpLink({
        url: "/solar-rec/api/trpc",
        transformer: superjson,
        fetch: trpcFetch,
      }),
      false: httpLink({
        url: "/solar-rec/api/main-trpc",
        transformer: superjson,
        fetch: trpcFetch,
      }),
    }),
  ],
});

// Solar REC typed trpc instance (for Settings, Monitoring, etc.)
const solarRecTrpcClient = solarRecTrpc.createClient({
  links: [
    httpLink({
      url: "/solar-rec/api/trpc",
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
