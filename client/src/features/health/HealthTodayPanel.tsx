/**
 * Today's health snapshot — unifies WhoopCard + SamsungHealthCard.
 *
 * Reuses the existing dashboard components directly. This page is the
 * second surface for them; both surfaces share the same tRPC queries.
 */

import { WhoopCard } from "@/components/dashboard/WhoopCard";
import { SamsungHealthCard } from "@/components/dashboard/SamsungHealthCard";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";

export function HealthTodayPanel() {
  const { user } = useAuth();

  const { data: integrations } = trpc.integrations.list.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  const hasWhoop = !!integrations?.some((i) => i.provider === "whoop");
  const hasSamsungHealth = !!integrations?.some(
    (i) => i.provider === "samsung-health"
  );

  const {
    data: whoopSummary,
    isLoading: whoopLoading,
    isFetching: whoopFetching,
    error: whoopError,
    refetch: refetchWhoop,
  } = trpc.whoop.getSummary.useQuery(undefined, {
    enabled: !!user && hasWhoop,
    retry: false,
    staleTime: 20 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <WhoopCard
        whoopSummary={whoopSummary}
        hasWhoop={hasWhoop}
        isLoading={whoopLoading}
        isFetching={whoopFetching}
        errorMessage={whoopError?.message ?? null}
        onRefresh={() => {
          void refetchWhoop();
        }}
        sectionRating={undefined}
      />
      <SamsungHealthCard
        snapshot={null}
        hasSamsungHealth={hasSamsungHealth}
        isRefreshing={false}
        onRefresh={() => {}}
        sectionRating={undefined}
      />
    </div>
  );
}
