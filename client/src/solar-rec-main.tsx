import { trpc } from "@/lib/trpc";
import { solarRecTrpc } from "./solar-rec/solarRecTrpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpLink } from "@trpc/client";
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

// Main app trpc instance used by meter read pages and shared dashboard helpers.
// Route this client directly to the main-trpc endpoint to avoid split-routing
// edge cases in production.
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
