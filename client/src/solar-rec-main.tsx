import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import SolarRecStandaloneApp from "./SolarRecStandaloneApp";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
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

// Use httpLink (no batching) pointing at the standalone Solar REC tRPC endpoint.
// We reuse the same `trpc` instance so SolarRecDashboard.tsx works unchanged.
const trpcClient = trpc.createClient({
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
    <QueryClientProvider client={queryClient}>
      <SolarRecStandaloneApp />
    </QueryClientProvider>
  </trpc.Provider>
);
