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

const linkOptions = {
  url: "/solar-rec/api/trpc",
  transformer: superjson,
  fetch: trpcFetch,
} as const;

// Main app trpc instance (for SolarRecDashboard which uses solarRecDashboard.* routes)
const trpcClient = trpc.createClient({
  links: [httpLink(linkOptions)],
});

// Solar REC typed trpc instance (for Settings, Monitoring, etc.)
const solarRecTrpcClient = solarRecTrpc.createClient({
  links: [httpLink(linkOptions)],
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
